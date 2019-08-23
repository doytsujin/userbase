import express from 'express'
import expressLogger from 'express-pino-logger'
import WebSocket from 'ws'
import http from 'http'
import https from 'https'
import fs from 'fs'

import bodyParser from 'body-parser'
import cookieParser from 'cookie-parser'
import logger from './logger'
import setup from './setup'
import auth from './auth'
import db from './db'
import connections from './ws'

const ONE_KB = 1024

// DynamoDB single item limit: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Limits.html#limits-items
const FOUR_HUNDRED_KB = 400 * ONE_KB

const app = express()
const distDir = "./dist"
const httpsKey = '../keys/key.pem'
const httpsCert = '../keys/cert.pem'
const httpPort = process.env.PORT || 8080
const httpsPort = process.env.PORT || 8443
const certExists = fs.existsSync(httpsKey) && fs.existsSync(httpsCert)

if (process.env.NODE_ENV == 'development') {
  logger.warn('Development Mode')
}

(async () => {
  try {
    await setup.init()

    const server = certExists ?
      https.createServer({ key: fs.readFileSync(httpsKey), cert: fs.readFileSync(httpsCert) }, app)
        .listen(httpsPort, () => logger.info(`App listening on https port ${httpsPort}....`)) :
      http.createServer(app)
        .listen(httpPort, () => logger.info(`App listening on http port ${httpPort}....`))

    const wss = new WebSocket.Server({ noServer: true })

    server.on('upgrade', (req, socket, head) => {
      const res = new http.ServerResponse(req)
      res.assignSocket(socket)
      res.on('finish', () => res.socket.destroy())
      req.ws = true
      res.ws = fn => wss.handleUpgrade(req, socket, head, fn)
      app(req, res)
    })

    const heartbeat = function () {
      this.isAlive = true
    }

    wss.on('connection', (ws, req, res) => {
      ws.isAlive = true

      const userId = res.locals.user['user-id']
      const conn = connections.register(userId, ws)
      const connectionId = conn.id

      ws.on('pong', heartbeat)
      ws.on('close', () => connections.close(conn))

      ws.on('message', async (msg) => {
        try {
          if (msg.length > FOUR_HUNDRED_KB || msg.byteLength > FOUR_HUNDRED_KB) return ws.send('Message is too large')

          const request = JSON.parse(msg)

          const requestId = request.requestId
          const action = request.action
          const params = request.params

          let response
          switch (action) {
            case 'CreateDatabase': {
              response = await db.createDatabase(
                userId,
                params.dbNameHash,
                params.dbId,
                params.encryptedDbName,
                params.encryptedDbKey,
                params.encryptedMetadata
              )
              break
            }
            case 'GetDatabase': {
              response = await db.getDatabase(userId, params.dbNameHash)
              break
            }
            case 'OpenDatabase': {
              response = await db.openDatabase(userId, connectionId, params.dbId, params.bundleSeqNo)
              break
            }
            case 'Insert':
            case 'Update':
            case 'Delete': {
              response = await db.doCommand(action, userId, params.dbId, params.itemKey, params.encryptedItem)
              break
            }
            case 'Batch': {
              response = await db.batch(userId, params.dbId, params.operations)
              break
            }
            case 'Bundle': {
              response = await db.bundleTransactionLog(userId, params.dbId, params.seqNo, params.bundle)
              break
            }
            default: {
              return ws.send(`Received unkown action ${action}`)
            }
          }

          ws.send(JSON.stringify({
            requestId,
            response,
            route: action
          }))

        } catch (e) {
          logger.error(`Error ${e.name}: ${e.message} in Websocket handling the following message from user ${userId}: ${msg}`)
        }

      })
    })

    setInterval(function ping() {
      wss.clients.forEach(ws => {
        if (ws.isAlive === false) return ws.terminate()

        ws.isAlive = false
        ws.ping(() => { })
      })
    }, 30000)

    app.use(expressLogger())
    app.use(express.static(distDir))
    app.use(bodyParser.json())
    app.use(cookieParser())

    app.get('/api', auth.authenticateUser, (req, res) =>
      req.ws
        ? res.ws(socket => wss.emit('connection', socket, req, res))
        : res.send('Not a websocket!')
    )

    app.post('/api/auth/sign-up', auth.signUp)
    app.post('/api/auth/validate-key', auth.authenticateUser, auth.validateKey)
    app.post('/api/auth/sign-in', auth.signIn)
    app.post('/api/auth/sign-out', auth.authenticateUser, auth.signOut)

    app.post('/api/auth/request-master-key', auth.authenticateUser, auth.requestMasterKey)
    app.get('/api/auth/get-master-key-requests', auth.authenticateUser, auth.queryMasterKeyRequests)
    app.post('/api/auth/send-master-key', auth.authenticateUser, auth.sendMasterKey)
    app.post('/api/auth/receive-master-key', auth.authenticateUser, auth.receiveMasterKey)
  } catch (e) {
    logger.info(`Unhandled error while launching server: ${e}`)
  }
})()
