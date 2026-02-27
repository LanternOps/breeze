import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users } from './users';

export type UserRiskFactorBreakdown = Record<string, number>;
export type UserRiskPolicyWeights = Record<string, number>;
export type UserRiskPolicyThresholds = {
  medium?: number;
  high?: number;
  critical?: number;
  spikeDelta?: number;
  autoAssignTrainingAtOrAbove?: number;
};
export type UserRiskPolicyInterventions = {
  autoAssignTraining?: boolean;
  trainingModuleId?: string;
  notifyOnHighRisk?: boolean;
  notifyOnRiskSpike?: boolean;
};

export const userRiskScores = pgTable('user_risk_scores', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  score: integer('score').notNull(),
  factors: jsonb('factors').$type<UserRiskFactorBreakdown>().notNull().default({}),
  trendDirection: varchar('trend_direction', { length: 20 }),
  calculatedAt: timestamp('calculated_at').notNull(),
}, (table) => ({
  orgUserCalcIdx: uniqueIndex('user_risk_org_user_calc_idx').on(table.orgId, table.userId, table.calculatedAt),
  scoreIdx: index('user_risk_score_idx').on(table.score),
  orgScoreIdx: index('user_risk_org_score_idx').on(table.orgId, table.score),
  orgUserIdx: index('user_risk_org_user_idx').on(table.orgId, table.userId),
}));

export const userRiskEvents = pgTable('user_risk_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  eventType: varchar('event_type', { length: 60 }).notNull(),
  severity: varchar('severity', { length: 20 }),
  scoreImpact: integer('score_impact').notNull().default(0),
  description: text('description').notNull(),
  details: jsonb('details'),
  occurredAt: timestamp('occurred_at').notNull(),
}, (table) => ({
  orgUserTimeIdx: index('user_risk_events_org_user_time_idx').on(table.orgId, table.userId, table.occurredAt),
  orgEventTypeTimeIdx: index('user_risk_events_org_event_type_time_idx').on(table.orgId, table.eventType, table.occurredAt),
}));

export const userRiskPolicies = pgTable('user_risk_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  weights: jsonb('weights').$type<UserRiskPolicyWeights>().notNull().default({}),
  thresholds: jsonb('thresholds').$type<UserRiskPolicyThresholds>().notNull().default({}),
  interventions: jsonb('interventions').$type<UserRiskPolicyInterventions>().notNull().default({}),
  updatedBy: uuid('updated_by').references(() => users.id),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  orgIdx: uniqueIndex('user_risk_policy_org_idx').on(table.orgId),
}));
