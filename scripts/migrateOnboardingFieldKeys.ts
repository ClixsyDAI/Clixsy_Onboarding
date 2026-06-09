/**
 * One-time migration: remap legacy field keys to canonical keys in onboarding_answers.
 *
 * Safety rules:
 * - Never overwrites a canonical key if it already exists
 * - Processes in batches
 * - Produces a migration log
 *
 * Usage:
 *   DRY_RUN=true npx tsx scripts/migrateOnboardingFieldKeys.ts   (preview only)
 *   npx tsx scripts/migrateOnboardingFieldKeys.ts                 (real migration)
 */

import { createClient } from '@supabase/supabase-js';
import { LEGACY_FIELD_ALIASES } from '../src/lib/onboarding/fieldRegistry';
import fs from 'fs';
import path from 'path';

const DRY_RUN = process.env.DRY_RUN === 'true';
const BATCH_SIZE = 50;

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

interface MigrationLog {
  started_at: string;
  dry_run: boolean;
  sessions_scanned: number;
  sessions_updated: number;
  answer_rows_scanned: number;
  answer_rows_updated: number;
  keys_migrated: number;
  conflicts_skipped: number;
  details: Array<{
    session_id: string;
    step_key: string;
    legacy_key: string;
    canonical_key: string;
    action: 'migrated' | 'conflict_skipped';
  }>;
  completed_at: string;
}

async function migrate() {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Field Key Migration ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'}`);
  console.log(`${'='.repeat(50)}\n`);

  const log: MigrationLog = {
    started_at: new Date().toISOString(),
    dry_run: DRY_RUN,
    sessions_scanned: 0,
    sessions_updated: 0,
    answer_rows_scanned: 0,
    answer_rows_updated: 0,
    keys_migrated: 0,
    conflicts_skipped: 0,
    details: [],
    completed_at: '',
  };

  // Fetch all answer rows in batches
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const { data: rows, error } = await supabase
      .from('onboarding_answers')
      .select('id, session_id, step_key, answers')
      .range(offset, offset + BATCH_SIZE - 1)
      .order('id');

    if (error) {
      console.error('Fetch error:', error.message);
      break;
    }

    if (!rows || rows.length === 0) {
      hasMore = false;
      break;
    }

    for (const row of rows) {
      log.answer_rows_scanned++;
      const answers = row.answers as Record<string, unknown>;
      if (!answers || typeof answers !== 'object') continue;

      const updatedAnswers = { ...answers };
      let rowChanged = false;

      for (const [legacyKey, canonicalKey] of Object.entries(LEGACY_FIELD_ALIASES)) {
        if (!(legacyKey in answers)) continue;

        // Check if canonical key already exists
        if (canonicalKey in answers) {
          log.conflicts_skipped++;
          log.details.push({
            session_id: row.session_id,
            step_key: row.step_key,
            legacy_key: legacyKey,
            canonical_key: canonicalKey,
            action: 'conflict_skipped',
          });
          continue;
        }

        // Migrate: copy legacy value to canonical key
        updatedAnswers[canonicalKey] = answers[legacyKey];
        // Keep legacy key for backward compat (don't delete)
        rowChanged = true;
        log.keys_migrated++;
        log.details.push({
          session_id: row.session_id,
          step_key: row.step_key,
          legacy_key: legacyKey,
          canonical_key: canonicalKey,
          action: 'migrated',
        });
      }

      if (rowChanged) {
        log.answer_rows_updated++;

        if (!DRY_RUN) {
          const { error: updateError } = await supabase
            .from('onboarding_answers')
            .update({ answers: updatedAnswers })
            .eq('id', row.id);

          if (updateError) {
            console.error(`Update failed for row ${row.id}:`, updateError.message);
          }
        }

        console.log(`  ${DRY_RUN ? '[DRY]' : '[LIVE]'} Updated ${row.step_key} (session: ${row.session_id.slice(0, 8)}...)`);
      }
    }

    offset += rows.length;
    if (rows.length < BATCH_SIZE) hasMore = false;
  }

  // Count unique sessions
  const uniqueSessions = new Set(log.details.map(d => d.session_id));
  log.sessions_scanned = log.answer_rows_scanned;
  log.sessions_updated = uniqueSessions.size;
  log.completed_at = new Date().toISOString();

  // Print summary
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Migration ${DRY_RUN ? '(DRY RUN)' : ''} Complete`);
  console.log(`  Answer rows scanned: ${log.answer_rows_scanned}`);
  console.log(`  Answer rows updated: ${log.answer_rows_updated}`);
  console.log(`  Keys migrated: ${log.keys_migrated}`);
  console.log(`  Conflicts skipped: ${log.conflicts_skipped}`);
  console.log(`  Sessions affected: ${log.sessions_updated}`);
  console.log(`${'='.repeat(50)}\n`);

  // Write log
  const logDir = path.join(__dirname, '..', 'field-naming-standardization', '2026-03-23', 'evidence');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `migration_log${DRY_RUN ? '_dry_run' : ''}.json`);
  fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
  console.log(`Log written to: ${logPath}`);
}

migrate().catch(console.error);
