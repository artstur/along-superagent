/** Strict device-produced aggregates; no HealthKit samples or private arbitrary payloads. */
import { z } from 'zod'

const timestamp = z.string().min(1).max(64).refine(value => Number.isFinite(Date.parse(value)))
const minutes = z.number().finite().nonnegative().max(1440).nullable().optional()
const count = z.number().int().nonnegative().max(10000)
const activity = z.string().regex(/^(?:yoga|walking|hiking|running|cycling|swimming|pilates|strength_training|hiit|traditionalStrengthTraining|traditional_strength_training|functionalStrengthTraining|functional_strength_training|highIntensityIntervalTraining|high_intensity_interval_training|healthkit_activity_[0-9]+)$/)
const observedMinutes=z.number().finite().min(0).max(1440).optional()
const stageMinutes=z.object({core:observedMinutes,deep:observedMinutes,rem:observedMinutes,unspecified:observedMinutes,awake:observedMinutes}).strict()
  .refine(value=>Object.values(value).some(n=>typeof n==='number'),'Stage summary needs an observed value')
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
  latestAsleepSegmentCount: count.min(1).optional(),
  latestLongestAsleepMinutes: z.number().finite().min(0).max(1440).optional(),
  latestStageMinutes: stageMinutes.optional(),
  latestStageOverlap: z.boolean().optional(),
}).strict().superRefine((value,ctx)=>{
  if([value.latestAsleepSegmentCount,value.latestLongestAsleepMinutes,value.latestStageMinutes,value.latestStageOverlap].some(x=>x!==undefined)&&typeof value.latestNightMinutes!=='number')
    ctx.addIssue({code:'custom',message:'Sleep details require observed latestNightMinutes'})
  if(value.latestStageOverlap!==undefined&&!value.latestStageMinutes)ctx.addIssue({code:'custom',message:'Stage overlap requires stage observations'})
  if(typeof value.latestNightMinutes==='number') {
    if(value.latestLongestAsleepMinutes!==undefined&&value.latestLongestAsleepMinutes>value.latestNightMinutes+1)ctx.addIssue({code:'custom',message:'Longest segment exceeds observed asleep duration'})
    const stages=value.latestStageMinutes
    if(stages&&['core','deep','rem','unspecified'].reduce((n,key)=>n+(stages[key as keyof typeof stages]??0),0)>value.latestNightMinutes+1)
      ctx.addIssue({code:'custom',message:'Asleep stages exceed observed asleep duration'})
  }
})
const workoutSession=z.object({
  activity,startAt:timestamp,endAt:timestamp,durationMinutes:z.number().finite().min(0).max(40320),
  location:z.enum(['indoor','outdoor','unknown']),
  distanceMeters:z.number().finite().min(0).max(1000000).optional(),
  activeEnergyKcal:z.number().finite().min(0).max(100000).optional(),
  averageHeartRateBpm:z.number().finite().positive().max(400).optional(),
  maximumHeartRateBpm:z.number().finite().positive().max(400).optional(),
  effortScore:z.number().finite().min(1).max(10).optional(),
  estimatedEffortScore:z.number().finite().min(1).max(10).optional(),
}).strict().superRefine((value,ctx)=>{
  const elapsed=(Date.parse(value.endAt)-Date.parse(value.startAt))/60000
  if(elapsed<0||value.durationMinutes>elapsed+1/60)ctx.addIssue({code:'custom',message:'Workout duration exceeds its observed elapsed window'})
  if(value.averageHeartRateBpm!==undefined&&value.maximumHeartRateBpm!==undefined&&value.averageHeartRateBpm>value.maximumHeartRateBpm)
    ctx.addIssue({code:'custom',message:'Average heart rate exceeds maximum'})
})
export const WorkoutContextSchema = z.object({
  windowDays: z.literal(28),
  weekStartAt: timestamp,
  todayMinutes: z.number().finite().min(0).max(40320),
  todayCount: count,
  yesterdayMinutes: z.number().finite().min(0).max(40320),
  latestWorkoutAt: timestamp,
  patterns: z.array(z.object({
    activity,
    weekday: z.number().int().min(1).max(7),
    hour: z.number().int().min(0).max(23),
    count,
    recentCount: count,
    averageMinutes: z.number().finite().min(0).max(40320),
    lastObservedAt: timestamp,
  }).strict().refine(value => value.recentCount <= value.count)).max(40),
  recentSessions:z.array(workoutSession).max(7).optional(),
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
    'Stage minutes and longest/segment counts are bounded observed intervals, not a diagnosis, a main sleep determination or proof of lights-out. Missing stage detail remains unknown.',
  ]
  if (type === 'workout') return [
    'value aggregates the current week; context patterns are grouped observed activity, not evidence of a booking or every planned workout.',
    'Missing records and incomplete windows do not prove a human action failed or finished.',
    'recentSessions are deduplicated summaries of up to seven observed workouts. durationMinutes is recorded active duration, not necessarily elapsed time. Missing distance, energy, heart rate or effort means not observed; never invent a zero or estimate a recorded score.',
    'location is only recorded indoor/outdoor/unknown, not a gym, city, coordinate or route. effortScore and estimatedEffortScore are distinct observed metrics and do not establish clinical recovery or recommended intensity.',
  ]
  return undefined
}
