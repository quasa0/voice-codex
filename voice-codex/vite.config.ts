import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { RawData } from 'ws'
import { WebSocketServer, WebSocket as WsClient } from 'ws'
import type { Plugin } from 'vite'
import path from 'node:path'

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

function getCodexTarget(wsUrl?: string) {
  if (!wsUrl) return 'ws://127.0.0.1:3000'
  try {
    const parsed = new URL(wsUrl)
    return parsed.searchParams.get('target') ?? 'ws://127.0.0.1:3000'
  } catch {
    return wsUrl.startsWith('ws://') || wsUrl.startsWith('wss://') ? wsUrl : 'ws://127.0.0.1:3000'
  }
}

function jsonRpcCall(
  ws: WsClient,
  method: string,
  params?: unknown,
  timeoutMs = 30000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1_000_000_000)
    const timeout = setTimeout(() => {
      ws.off('message', onMessage)
      reject(new Error(`Timeout waiting for ${method}`))
    }, timeoutMs)

    const onMessage = (data: RawData) => {
      try {
        const parsed = JSON.parse(rawDataToText(data)) as Record<string, unknown>
        if (parsed.id !== id) return
        clearTimeout(timeout)
        ws.off('message', onMessage)
        if (parsed.error) {
          const error = parsed.error as { message?: string }
          reject(new Error(error.message ?? `JSON-RPC error for ${method}`))
          return
        }
        resolve(parsed.result)
      } catch (error) {
        clearTimeout(timeout)
        ws.off('message', onMessage)
        reject(error instanceof Error ? error : new Error(`Failed to parse response for ${method}`))
      }
    }

    ws.on('message', onMessage)
    ws.send(JSON.stringify({ jsonrpc: '2.0', method, id, params }))
  })
}

async function loginCodexWithServerKey(target: string) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set for the Vite dev server')
  }

  const ws = new WsClient(target)

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout connecting to Codex app-server')), 10000)
    ws.once('open', () => {
      clearTimeout(timeout)
      resolve()
    })
    ws.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })

  try {
    await jsonRpcCall(ws, 'initialize', {
      clientInfo: { name: 'voice-codex-vite', title: 'Voice Codex Dev Server', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    })
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }))
    await jsonRpcCall(ws, 'account/login/start', { type: 'apiKey', apiKey: process.env.OPENAI_API_KEY })
    const account = await jsonRpcCall(ws, 'account/read', { refreshToken: false })
    const models = await jsonRpcCall(ws, 'model/list', { includeHidden: false })
    return { account, models }
  } finally {
    ws.close()
  }
}

async function routeIntentWithServerModel(payload: {
  message: string
  codexRunning: boolean
  latestCodexReply?: string | null
  recentConversation?: Array<{ role: string; text: string }>
}) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set for the Vite dev server')
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-5.4-mini',
      reasoning_effort: 'low',
      messages: [
        {
          role: 'system',
          content:
            [
              'You route user intent between realtime chat and Codex worker. Return JSON only.',
              'Use Codex whenever the user asks about the local project, repo, files, code, implementation, architecture, components, or behavior of "our app", "this app", "the todo app", or similar project-specific wording.',
              'If answering would require inspecting workspace contents or remembering what Codex built earlier, route to Codex rather than letting realtime answer from general knowledge.',
              'Prefer codex_start for project inspection/work when Codex is idle.',
              'Prefer codex_steer for follow-up project questions or modifications when Codex is already running.',
              'Prefer codex_interrupt only when the user clearly redirects or replaces in-flight Codex work.',
              'Prefer chat_only only for casual conversation, generic knowledge, or pure voice-control requests like "stop", "stop yapping", "be quiet", or similar.',
              'If the user asks to hear, repeat, summarize, or relay the latest Codex result, use action=chat_only and chat_mode=relay_latest_codex.',
              'Never invent project facts. If the question is about the local project, Codex should inspect it.',
              'Examples that MUST route to Codex: "tell me about our todo app", "what files do we have", "how is this implemented", "what did Codex build", "explain this project".',
              'Examples that can stay chat_only: "stop", "thanks", "what is React", "explain CRUD generally".',
            ].join(' '),
        },
        {
          role: 'user',
          content: JSON.stringify(payload),
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'intent_route',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              action: {
                type: 'string',
                enum: ['chat_only', 'codex_start', 'codex_steer', 'codex_interrupt'],
              },
              chat_mode: {
                type: 'string',
                enum: ['normal', 'relay_latest_codex'],
              },
              reason: { type: 'string' },
            },
            required: ['action', 'chat_mode', 'reason'],
          },
        },
      },
    }),
  })

  const text = await response.text()
  if (!response.ok) {
    throw new Error(text || `Intent route request failed with ${response.status}`)
  }

  const parsed = JSON.parse(text) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const content = parsed.choices?.[0]?.message?.content
  if (!content) {
    throw new Error('No intent route content returned')
  }

  return JSON.parse(content) as {
    action: 'chat_only' | 'codex_start' | 'codex_steer' | 'codex_interrupt'
    chat_mode: 'normal' | 'relay_latest_codex'
    reason: string
  }
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
                    interrupt_response: true,
                  },
                },
                output: {
                  voice: body.voice ?? 'marin',
                  speed: 1.2,
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

      server.middlewares.use('/__codex_app_server/account/login', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('Method not allowed')
          return
        }

        try {
          const body = (await readJsonBody(req)) as { wsUrl?: string }
          const result = await loginCodexWithServerKey(getCodexTarget(body.wsUrl))
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify(result))
        } catch (error) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'text/plain; charset=utf-8')
          res.end(error instanceof Error ? error.message : 'Failed to log into Codex app-server with server API key')
        }
      })

      server.middlewares.use('/__intent/route', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('Method not allowed')
          return
        }

        try {
          const body = (await readJsonBody(req)) as {
            message?: string
            codexRunning?: boolean
            latestCodexReply?: string | null
            recentConversation?: Array<{ role: string; text: string }>
          }
          if (!body.message?.trim()) {
            res.statusCode = 400
            res.end('Missing message')
            return
          }

          const result = await routeIntentWithServerModel({
            message: body.message,
            codexRunning: Boolean(body.codexRunning),
            latestCodexReply: body.latestCodexReply ?? null,
            recentConversation: body.recentConversation ?? [],
          })
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify(result))
        } catch (error) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'text/plain; charset=utf-8')
          res.end(error instanceof Error ? error.message : 'Failed to route intent')
        }
      })

      server.httpServer?.on('close', () => wss.close())
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), codexProxyPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
