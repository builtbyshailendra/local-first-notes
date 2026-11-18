// Run the sync server and serve the built web app.
//   npm run build && npm start      (PORT, DB_PATH, STATIC_DIR to override)

import path from 'node:path'
import { startServer } from './server.ts'

const root = path.resolve(import.meta.dirname, '..', '..')
const server = await startServer({
  port: Number(process.env.PORT ?? 8097),
  dbPath: process.env.DB_PATH ?? path.join(root, 'notes.db'),
  staticDir: process.env.STATIC_DIR ?? path.join(root, 'web', 'dist'),
})
console.log(`local-first-notes on http://127.0.0.1:${server.port}  (sync: ${server.url}/rooms/<incident>)`)

const stop = async (): Promise<void> => {
  await server.close()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
