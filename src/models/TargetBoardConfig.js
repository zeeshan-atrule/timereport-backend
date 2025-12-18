import mongoose from 'mongoose'

const TargetBoardConfigSchema = new mongoose.Schema(
  {
    // The source/time-tracking board (same as Configuration.boardId)
    sourceBoardId: { type: Number, required: true, index: true, unique: true },

    // The target/monthly-report board where we will write per-employee monthly rows
    targetBoardId: { type: Number, required: true },

    // Mapping: employeeId (or fallback employeeName) -> groupId on the target board
    employeeGroups: {
      type: Map,
      of: String,
      default: {}
    },

    // Mapping: groupId -> { [clientName]: columnId } on the target board
    groupClientColumns: {
      type: Map,
      of: Object,
      default: {}
    },

    // Optional extra columns on the target board for totals
    totalWorkedHoursColumnId: { type: String },
    totalClientHoursColumnId: { type: String },
    // New: subitem worked hours column
    subitemWorkedHoursColumnId: { type: String }
  },
  {
    timestamps: true
  }
)

export default mongoose.model('TargetBoardConfig', TargetBoardConfigSchema)


