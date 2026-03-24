import { runMonthlyReportJob } from '../cronMonthlyReport.js';

export default async function handler(req, res) {
  try {
    // const today = new Date()
    // const tomorrow = new Date(today)
    // tomorrow.setDate(today.getDate() + 1)
    // const isLastDay = today.getMonth() !== tomorrow.getMonth()

    // if (!isLastDay) {
    //   return res.status(200).json({ success: false, message: 'Not last day of month, skipping job.' })
    // }

    await runMonthlyReportJob('vercel-cron')
    res.status(200).json({ success: true })
  } catch (err) {
    console.error('[VERCEL CRON ERROR]', err)
    res.status(500).json({ error: err.message })
  }
}
