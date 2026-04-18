import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import type { RawData } from 'ws'
import { WebSocketServer, WebSocket as WsClient } from 'ws'
import type { Plugin } from 'vite'

const PROXY_PORT = 3001

function rawDataToText(data: RawData): string {
  return typeof data === 'string' ? data : data.toString()
}

async function readJsonBody(req: NodeJS.ReadableStream) {
  let body = ''
  for await (const chunk of req) {
    body += typeof chunk === 'string' ? chunk : chunk.toString()
  }
  return body ? JSON.parse(body) : {}
}

function codexProxyPlugin(): Plugin {
  return {
    name: 'codex-ws-proxy',
    configureServer(server) {
      const wss = new WebSocketServer({ port: PROXY_PORT })

      wss.on('connection', (browserWs, req) => {
        const url = new URL(req.url ?? '/', `http://localhost:${PROXY_PORT}`)
        const target = url.searchParams.get('target') ?? 'ws://127.0.0.1:3000'

        const queue: string[] = []
        const codexWs = new WsClient(target)

        browserWs.on('message', (data) => {
          const text = rawDataToText(data)
          if (codexWs.readyState === WsClient.OPEN) {
            codexWs.send(text)
          } else {
            queue.push(text)
          }
        })
        browserWs.on('close', () => codexWs.close())
        browserWs.on('error', () => codexWs.close())

        codexWs.on('open', () => {
          for (const msg of queue) codexWs.send(msg)
          queue.length = 0
        })
        codexWs.on('message', (data) => {
          if (browserWs.readyState === WsClient.OPEN) browserWs.send(rawDataToText(data))
        })
        codexWs.on('close', () => browserWs.close())
        codexWs.on('error', (err) => {
          console.error('[codex-proxy] upstream error:', err.message)
          browserWs.close()
        })
      })

      wss.on('listening', () => {
        console.log(`[codex-proxy] proxy listening on ws://localhost:${PROXY_PORT}`)
      })

      server.middlewares.use('/__openai_realtime/session', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('Method not allowed')
          return
        }

        if (!process.env.OPENAI_API_KEY) {
          res.statusCode = 500
          res.end('OPENAI_API_KEY is not set for the Vite dev server')
          return
        }

        try {
          const body = (await readJsonBody(req)) as {
            sdp?: string
            model?: string
            voice?: string
            instructions?: string
          }

          if (!body.sdp) {
            res.statusCode = 400
            res.end('Missing SDP offer')
            return
          }

          const formData = new FormData()
          formData.set('sdp', body.sdp)
          formData.set(
            'session',
            JSON.stringify({
              type: 'realtime',
              model: body.model ?? 'gpt-realtime',
              instructions: body.instructions?.trim() || undefined,
              audio: {
                input: {
                  transcription: {
                    model: 'gpt-4o-mini-transcribe',
                  },
                  turn_detection: {
                    type: 'server_vad',
                    threshold: 0.7,
                    prefix_padding_ms: 500,
                    silence_duration_ms: 900,
                    create_response: false,
                    interrupt_response: false,
                  },
                },
                output: {
                  voice: body.voice ?? 'marin',
                },
              },
            }),
          )

          const response = await fetch('https://api.openai.com/v1/realtime/calls', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            },
            body: formData,
          })

          const text = await response.text()
          res.statusCode = response.status
          res.setHeader('Content-Type', response.ok ? 'application/sdp' : 'text/plain; charset=utf-8')
          res.end(text)
        } catch (error) {
          res.statusCode = 500
          res.end(error instanceof Error ? error.message : 'Failed to create OpenAI Realtime session')
        }
      })

      server.httpServer?.on('close', () => wss.close())
    },
  }
}

export default defineConfig({
  plugins: [react(), codexProxyPlugin()],
})
