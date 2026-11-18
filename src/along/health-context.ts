/** Strict device-produced aggregates; no HealthKit samples or private arbitrary payloads. */
import { z } from 'zod'

const timestamp = z.string().min(1).max(64).refine(value => Number.isFinite(Date.parse(value)))
const minutes = z.number().finite().nonnegative().max(1440).nullable().optional()
const count = z.number().int().nonnegative().max(10000)
export const SleepContextSchema = z.object({
  windowDays: z.literal(7),
  daysWithData: z.number().int().min(0).max(7),
  averageThroughAt: timestamp,
  latestWindowOpen: z.boolean(),
  averageMinutes: minutes,
  latestNightMinutes: minutes,
  previousNightMinutes: minutes,
  latestSleepStartAt: timestamp.nullable().optional(),
  latestWakeAt: timestamp.nullable().optional(),
}).strict()
export const WorkoutContextSchema = z.object({
  windowDays: z.literal(28),
  weekStartAt: timestamp,
  todayMinutes: z.number().finite().min(0).max(40320),
  todayCount: count,
  yesterdayMinutes: z.number().finite().min(0).max(40320),
  latestWorkoutAt: timestamp,
  patterns: z.array(z.object({
    activity: z.string().regex(/^(?:yoga|walking|hiking|running|cycling|swimming|pilates|traditionalStrengthTraining|traditional_strength_training|functionalStrengthTraining|functional_strength_training|highIntensityIntervalTraining|high_intensity_interval_training|healthkit_activity_[0-9]+)$/),
    weekday: z.number().int().min(1).max(7),
    hour: z.number().int().min(0).max(23),
    count,
    recentCount: count,
    averageMinutes: z.number().finite().min(0).max(40320),
    lastObservedAt: timestamp,
  }).strict().refine(value => value.recentCount <= value.count)).max(40),
}).strict()
export const HealthContextSchema = z.union([SleepContextSchema, WorkoutContextSchema])
export type HealthContext = z.infer<typeof HealthContextSchema>

/** Describes source semantics, not clinical thresholds or a goal-specific decision. */
export function healthInterpretation(type: string) {
  if (type === 'sleep') return [
    'value is summed observed asleep duration in minutes, not bedtime, lights-out or task completion.',
    'window.start/end are aggregation boundaries (18:00 local for this producer); a future window.end does not invalidate observed sleep.',
    'context.latestSleepStartAt/latestWakeAt are first/last observed asleep bounds; fragmented sleep, naps and incomplete coverage can affect them. They do not establish a main sleep episode.',
    'Use summary.timezone and the full night across midnight for civil-time comparisons. Missing bounds mean unknown, not a passing bedtime target.',
    'latestNightMinutes and previousNightMinutes refer to their labelled windows; only still-applicable evidence supports a plan change.',
  ]
  if (type === 'workout') return [
    'value aggregates the current week; context patterns are grouped observed activity, not evidence of a booking or every planned workout.',
    'Missing records and incomplete windows do not prove a human action failed or finished.',
  ]
  return undefined
}
