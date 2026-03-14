/**
 * Alert Templates Data
 *
 * Previously contained in-memory mock data for templates, rules, and correlations.
 * All data is now persisted in the database:
 * - Templates: alertTemplates table (built-in templates seeded via migration 0003)
 * - Rules: alertRules table
 * - Correlations: alertCorrelations table
 *
 * This file is kept for backward compatibility but exports nothing.
 */
