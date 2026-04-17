import { runGroupConfigUpdate } from '../cronMonthlyReport.js';

/**
 * GET /api/cron/update-group-config
 *
 * Standalone trigger for the group config rolling update.
 * Runs independently of the main monthly report cron job.
 *
 * Checks all board configurations and, for any where the current
 * month doesn't yet have 3 groups set up, it will:
 *   1. Pull the 2 permanent groups from the previous month's config
 *   2. Find the board group named after the current month (e.g. "April 2026")
 *   3. Set current month → [currentMonthGroup, permanentGroup1, permanentGroup2]
 *   4. Set previous month → [previousMonthGroup] only (strip permanent groups)
 */
export default async function handler(req, res) {
  try {
    await runGroupConfigUpdate();
    res.status(200).json({ success: true, message: 'Group config update completed.' });
  } catch (err) {
    console.error('[GROUP UPDATE ROUTE ERROR]', err);
    res.status(500).json({ success: false, error: err.message });
  }
}
