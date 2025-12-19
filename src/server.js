import express from 'express'
import cors from 'cors'
import morgan from 'morgan'
import mongoose from 'mongoose'
import dotenv from 'dotenv'


import configRoutes from './routes/config.js'
import syncRoutes from './routes/sync.js'
import targetConfigRoutes from './routes/targetConfig.js'
// import { startMonthlyReportCron } from './cronMonthlyReport.js'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 4000
const allowOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
  : []

app.use(
  cors({
    origin: allowOrigins.length ? allowOrigins : '*'
  })
)
app.use(express.json({ limit: '1mb' }))
app.use(morgan('dev'))

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

app.use('/api/config', configRoutes)
app.use('/api/sync', syncRoutes)
app.use('/api/target-config', targetConfigRoutes)

app.use((err, _req, res, _next) => {
  console.error(err)
  res.status(500).json({ message: err.message || 'Internal server error' })
})


const start = async () => {
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is required')
  }
  await mongoose.connect(process.env.MONGO_URI)
  console.log('Connected to MongoDB')
  // Start the monthly report cron job
  // startMonthlyReportCron()
  app.listen(PORT, () => console.log(`Backend listening on ${PORT}`))
}

start().catch((err) => {
  console.error('Failed to start server', err)
  process.exit(1)
})


