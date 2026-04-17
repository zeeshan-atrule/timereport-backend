import Configuration from './models/Configuration.js'
import MonthlyReport from './models/MonthlyReport.js'
import TargetBoardConfig from './models/TargetBoardConfig.js'
import { fetchGroupItems, buildTasksFromItems, updateMonthRowForEmployee, updateEmployeeSubitemWorkedHours, createTargetBoardItems, fetchBoardColumnsAndGroups } from './services/monday.js'

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];
const MONTH_NAME_PATTERN = /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})$/;
const getCurrentMonthRange = () => {
  const now = new Date()
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth()
  const start = new Date(Date.UTC(year, month, 1))
  const end = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999))
  const toStr = (d) => d.toISOString().substring(0, 10)

  const key = `${year}-${String(month + 1).padStart(2, '0')}`
  const name = `${MONTH_NAMES[month]} ${year}`

  return { start: toStr(start), end: toStr(end), key, name }
}

const isLastDayOfMonth = () => {
  const today = new Date()
  const tomorrow = new Date(today)
  tomorrow.setDate(today.getDate() + 1)
  return today.getMonth() !== tomorrow.getMonth()
}

let isCronJobRunning = false;

// Helper: get groups array for a month key from config
const getConfigGroups = (config, key) => {
  if (config.groupConfig instanceof Map) return config.groupConfig.get(key) || [];
  return (config.groupConfig || {})[key] || [];
};

// Helper: set groups array for a month key in config
const setConfigGroups = (config, key, value) => {
  if (config.groupConfig instanceof Map) {
    config.groupConfig.set(key, value);
  } else {
    if (!config.groupConfig) config.groupConfig = {};
    config.groupConfig[key] = value;
  }
};

/**
 * updateAllMonthsGroupConfig
 *
 * groupConfig rules:
 *   - Current month → 3 groups: [currentMonthNamedGroup, permanentGroup1, permanentGroup2]
 *   - All previous months → 1 group each: [thatMonthNamedGroup]
 *
 * When the month rolls over this function:
 *   1. Checks if current month already has 3 groups → if yes, skips (already set up).
 *   2. Reads previous month's config to extract the 2 permanent (non-month-named) groups.
 *   3. Finds the board group whose title = current month name (e.g. "April 2026").
 *   4. Sets current month config  → [currentMonthNamedGroupId, permanentGroup1Id, permanentGroup2Id]
 *   5. Sets previous month config → [previousMonthNamedGroupId]  (permanent groups removed)
 *   6. Saves the configuration.
 */
const updateAllMonthsGroupConfig = async (config, apiToken) => {
  try {
    // Compute current and previous month keys + names
    const now = new Date();
    const year = now.getUTCFullYear();
    const monthIndex = now.getUTCMonth(); // 0-based

    const currentMonthKey = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
    const currentMonthName = `${MONTH_NAMES[monthIndex]} ${year}`;

    const prevDate = new Date(Date.UTC(year, monthIndex - 1, 1));
    const prevYear = prevDate.getUTCFullYear();
    const prevMonthIdx = prevDate.getUTCMonth();
    const prevMonthKey = `${prevYear}-${String(prevMonthIdx + 1).padStart(2, '0')}`;
    const prevMonthName = `${MONTH_NAMES[prevMonthIdx]} ${prevYear}`;

    const currentGroups = getConfigGroups(config, currentMonthKey);

    // If current month already has 3 groups — fully configured, nothing to do
    if (currentGroups.length === 3) {
      console.log(`[GROUP UPDATE] Board ${config.boardId}: ${currentMonthKey} already has 3 groups. Skipping.`);
      return;
    }

    console.log(`[GROUP UPDATE] Board ${config.boardId}: ${currentMonthKey} has ${currentGroups.length} group(s). Running update...`);

    // Fetch live groups from the Monday board
    const { groups } = await fetchBoardColumnsAndGroups(config.boardId, apiToken);
    if (!groups || groups.length === 0) {
      console.error(`[GROUP UPDATE] Board ${config.boardId}: No groups returned from API.`);
      return;
    }

    // Map groupId → title for quick lookup
    const groupTitleById = new Map(groups.map(g => [g.id, g.title]));

    // Find the board group titled e.g. "April 2026" (current month)
    const currentMonthBoardGroup = groups.find(g => g.title === currentMonthName);
    if (!currentMonthBoardGroup) {
      console.error(`[GROUP UPDATE] Board ${config.boardId}: No board group found with title "${currentMonthName}". Cannot update.`);
      return;
    }

    // ── Step 1: Extract the 2 permanent groups from previous month config ──
    const prevGroups = getConfigGroups(config, prevMonthKey);

    // Permanent = groups whose title does NOT match a month name pattern
    const prevMonthNamedIds = prevGroups.filter(id => {
      const title = groupTitleById.get(id);
      return title && MONTH_NAME_PATTERN.test(title);
    });
    const prevPermanentIds = prevGroups.filter(id => {
      const title = groupTitleById.get(id);
      return !title || !MONTH_NAME_PATTERN.test(title);
    });

    if (prevPermanentIds.length < 2) {
      console.warn(`[GROUP UPDATE] Board ${config.boardId}: Previous month ${prevMonthKey} has only ${prevPermanentIds.length} permanent group(s) (expected 2). Using what's available.`);
    }

    // ── Step 2: Set current month → [currentMonthNamedGroup, ...permanentGroups] ──
    const newCurrentGroups = [currentMonthBoardGroup.id, ...prevPermanentIds];
    setConfigGroups(config, currentMonthKey, newCurrentGroups);
    console.log(`[GROUP UPDATE] Board ${config.boardId}: ${currentMonthKey} → [${newCurrentGroups.join(', ')}] ("${currentMonthName}" + ${prevPermanentIds.length} permanent group(s))`);

    // ── Step 3: Set previous month → keep ONLY its month-named group ──
    const prevMonthBoardGroup = groups.find(g => g.title === prevMonthName);
    const prevMonthNamedId = prevMonthBoardGroup?.id || prevMonthNamedIds[0] || null;

    if (prevMonthNamedId) {
      setConfigGroups(config, prevMonthKey, [prevMonthNamedId]);
      console.log(`[GROUP UPDATE] Board ${config.boardId}: ${prevMonthKey} → [${prevMonthNamedId}] ("${prevMonthName}" only — permanent groups removed)`);
    } else {
      console.warn(`[GROUP UPDATE] Board ${config.boardId}: Could not find named group for ${prevMonthKey}. Leaving it unchanged.`);
    }

    // Persist
    await config.save();
    console.log(`[GROUP UPDATE] Board ${config.boardId}: Configuration saved successfully.`);

  } catch (err) {
    console.error(`[GROUP UPDATE] Error updating group config for board ${config.boardId}:`, err);
  }
};

/**
 * runGroupConfigUpdate — standalone exported function.
 * Can be triggered independently via its own API route or cron schedule,
 * separate from the main monthly report job.
 * Checks ALL configurations and updates any where the current month
 * doesn't yet have 3 groups configured.
 */
export const runGroupConfigUpdate = async () => {
  console.log('[GROUP UPDATE] Running standalone group config check...');
  try {
    const configs = await Configuration.find({});
    if (!configs || configs.length === 0) {
      console.log('[GROUP UPDATE] No configurations found.');
      return;
    }
    for (const config of configs) {
      const apiToken = config.apiToken || null;
      if (!apiToken) {
        console.warn(`[GROUP UPDATE] Board ${config.boardId}: No API token. Skipping.`);
        continue;
      }
      await updateAllMonthsGroupConfig(config, apiToken);
    }
    console.log('[GROUP UPDATE] Standalone update complete.');
  } catch (err) {
    console.error('[GROUP UPDATE] Fatal error during standalone update:', err);
  }
};

export const runMonthlyReportJob = async (triggerSource = 'manual') => {
  if (isCronJobRunning) {
    return
  }

  isCronJobRunning = true;

  try {
    const configs = await Configuration.find({})

    // Process configs in batches concurrently
    const configBatchSize = 3;
    for (let i = 0; i < configs.length; i += configBatchSize) {
      const batchConfigs = configs.slice(i, i + configBatchSize);

      await Promise.all(batchConfigs.map(async (config) => {
        try {
          const boardId = config.boardId
          const monthRange = getCurrentMonthRange()

          // === EXTRACT TOKEN FROM CONFIG ===
          const apiToken = config.apiToken || null;

          // Check if token exists
          if (!apiToken) {
            console.error(`[CRON] No API Token found in configuration for board ${boardId}. Skipping.`);
            return;
          }
          // ==================================

          const targetConfig = await TargetBoardConfig.findOne({ sourceBoardId: boardId })
          const targetGroups = config.groupConfig?.get
            ? config.groupConfig.get(monthRange.key)
            : config.groupConfig?.[monthRange.key]
          if (!targetGroups || targetGroups.length === 0) {
            return;
          }
          const requestedColumnIds = [
            config.columns.employee,
            config.columns.client,
            config.columns.timeTracking1,
            config.columns.timeTracking2
          ]
            .filter(Boolean)
            .map((id) => `"${id}"`)
            .join(',')

          // === PASS TOKEN TO FETCH ITEMS ===
          const items = await fetchGroupItems(boardId, targetGroups, requestedColumnIds, 500, apiToken)
          // ===============================

          const rawTasks = buildTasksFromItems(items, config.columns, { start: monthRange.start, end: monthRange.end });

          const mod = await import('./services/monday.js')
          const tasks = mod.aggregateTasksByEmployeeClientMonth(rawTasks)

          await MonthlyReport.deleteOne({ boardId, monthKey: monthRange.key })
          await MonthlyReport.create({
            boardId,
            monthKey: monthRange.key,
            monthName: monthRange.name,
            tasks,
            generatedAt: new Date()
          })

          if (targetConfig) {
            const monthlyReport = await MonthlyReport.findOne({ boardId, monthKey: monthRange.key })
            if (monthlyReport && Array.isArray(monthlyReport.tasks)) {
              const monthLabel = monthlyReport.monthName || monthRange.name || monthRange.key

              // === PASS TOKEN TO CREATE TARGET ITEMS ===
              await createTargetBoardItems(targetConfig, monthlyReport.tasks, monthLabel, apiToken);
              // ======================================
            }
          }

          // === PASS TOKEN TO UPDATE GROUP CONFIG ===
          await updateAllMonthsGroupConfig(config, apiToken);
          // =======================================
        } catch (err) {
          console.error(`[CRON] Error processing config for board ${config.boardId}:`, err);
        }
      }));
    }
  } catch (err) {
    console.error('[CRON] Error syncing monthly reports:', err)
  } finally {
    isCronJobRunning = false;
  }

  // Run group config rolling update after the main report job completes.
  // This promotes the new month's group and demotes the previous month's permanent groups.
  await runGroupConfigUpdate();
}