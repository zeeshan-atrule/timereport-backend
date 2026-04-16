import express from 'express'
import cors from 'cors'
import morgan from 'morgan'
import mongoose from 'mongoose'
import dotenv from 'dotenv'

import configRoutes from './routes/config.js'
import syncRoutes from './routes/sync.js'
import targetConfigRoutes from './routes/targetConfig.js'
import monthlyReportHandler from './routes/monthly-report.js'
import updateGroupConfigHandler from './routes/update-group-config.js'
import AuditlogRoutes from './routes/audit-logs.js'

dotenv.config()

const app = express()

const allowOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
  : []

app.use(cors({ origin: allowOrigins.length ? allowOrigins : '*' }))
app.use(express.json({ limit: '1mb' }))
app.use(morgan('dev'))

// ── Lazy MongoDB connection (cached across warm invocations) ─────────────────
let isDbConnected = false

const connectDb = async () => {
  if (isDbConnected && mongoose.connection.readyState === 1) return
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set')
  await mongoose.connect(process.env.MONGO_URI)
  isDbConnected = true
  console.log('[DB] Connected to MongoDB')
}

app.use(async (_req, _res, next) => {
  try {
    await connectDb()
    next()
  } catch (err) {
    next(err)
  }
})
// ─────────────────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' })
})

app.use('/api/config', configRoutes)
app.use('/api/sync', syncRoutes)
app.use('/api/target-config', targetConfigRoutes)
app.get('/api/cron/monthly-report', monthlyReportHandler)
app.get('/api/cron/update-group-config', updateGroupConfigHandler)
app.use('/api', AuditlogRoutes)

app.use((err, _req, res, _next) => {
  console.error(err)
  res.status(500).json({ message: err.message || 'Internal server error' })
})

// ── Local dev: start HTTP server (Vercel handles this in production) ──────────
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 4000
  app.listen(PORT, () => console.log(`Backend listening on ${PORT}`))
}
// ─────────────────────────────────────────────────────────────────────────────

// Required for Vercel — export the Express app as the serverless handler
export default app
