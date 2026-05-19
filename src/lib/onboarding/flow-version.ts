import { onboardingSteps, validateStepData, getMissingRequiredFields } from './steps';
import { onboardingStepsV2, validateStepDataV2, getMissingRequiredFieldsV2 } from './steps-v2';
import type { OnboardingStep, VerticalId } from './steps';

export type FlowVersion = 'v1' | 'v2';

export function getStepsForVersion(v: FlowVersion | string): OnboardingStep[] {
  return v === 'v2' ? onboardingStepsV2 : onboardingSteps;
}

export function validateStepDataForVersion(
  v: FlowVersion | string,
  stepKey: string,
  data: Record<string, unknown>
): { success: boolean; errors?: Record<string, string> } {
  return v === 'v2'
    ? validateStepDataV2(stepKey, data)
    : validateStepData(stepKey, data);
}

/**
 * `vertical` was added in the Stage 9 / home-services PR. It lets the
 * v2 missing-required-fields scan honour `requiredWhen` predicates on
 * individual fields (e.g. `service_trades` is required only when
 * `vertical === 'home_services'`, `primary_case_types_keywords` only
 * when `vertical === 'law_firm'`). v1 ignores it — pre-Stage-1 sessions
 * never had a vertical column.
 */
export function getMissingRequiredFieldsForVersion(
  v: FlowVersion | string,
  answers: Record<string, Record<string, unknown>>,
  vertical?: VerticalId
): { stepKey: string; stepTitle: string; stepIndex: number; fieldName: string; fieldLabel: string }[] {
  return v === 'v2'
    ? getMissingRequiredFieldsV2(answers, vertical)
    : getMissingRequiredFields(answers);
}
