import mongoose from 'mongoose'
import {runMonthlyReportJob} from '../cronMonthlyReport.js'
export default async function handler(req, res) {
  try {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGO_URI)
    }

    await runMonthlyReportJob('vercel-cron')

    res.status(200).json({ success: true })
  } catch (err) {
    console.error('[VERCEL CRON ERROR]', err)
    res.status(500).json({ error: err.message })
  }
}
