import express from 'express'
import cors from 'cors'
import morgan from 'morgan'
import mongoose from 'mongoose'
import dotenv from 'dotenv'

import configRoutes from './routes/config.js'
import syncRoutes from './routes/sync.js'
import targetConfigRoutes from './routes/targetConfig.js'
import monthlyReportHandler from './routes/monthly-report.js'
import auditLogRoutes from './routes/audit-logs.js'

dotenv.config()

const app = express()

// ---------- MongoDB Connection (Cached) ----------
let isConnected = false

async function connectDB() {
  if (isConnected) return

  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is required')
  }

  await mongoose.connect(process.env.MONGO_URI)
  isConnected = true
  console.log('MongoDB connected')
}

// ---------- Middlewares ----------
const allowOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : '*'

app.use(cors({ origin: allowOrigins }))
app.use(express.json({ limit: '1mb' }))
app.use(morgan('dev'))

// ---------- Routes ----------
app.get('/health', async (_req, res) => {
  await connectDB()
  res.json({ status: 'ok' })
})

app.use('/api', auditLogRoutes)
app.use('/api/config', configRoutes)
app.use('/api/sync', syncRoutes)
app.use('/api/target-config', targetConfigRoutes)
app.get('/api/cron/monthly-report', monthlyReportHandler)

// ---------- Error Handler ----------
app.use((err, _req, res, _next) => {
  console.error(err)
  res.status(500).json({ message: err.message || 'Internal server error' })
})

// ✅ THIS IS CRITICAL FOR VERCEL
export default async function handler(req, res) {
  await connectDB()
  return app(req, res)
}
