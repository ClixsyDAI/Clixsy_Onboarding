'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { getStepsForVersion, validateStepDataForVersion, getMissingRequiredFieldsForVersion } from '@/lib/onboarding/flow-version';
import type { VerticalId } from '@/lib/onboarding/steps';
import StepRenderer from './StepRenderer';
import StepTransition from './StepTransition';
import AccessChecklistStep from './AccessChecklistStep';
import WebsiteSnapshot from './WebsiteSnapshot';
import WelcomeModal from './WelcomeModal';
import { clampInitialStep } from '@/lib/onboarding/wizard-state';
import ThankYou from './ThankYou';
import { getTransitionMessage, getWelcomeMessage } from '@/lib/onboarding/transition-messages';
import type { TransitionMessage } from '@/lib/onboarding/transition-messages';

const CLIXSY_LOGO_URL = 'https://res.cloudinary.com/dovgh19xr/image/upload/v1766427227/new_logo_nvrux0.svg';

interface SiteIntelligenceData {
  prefill_map?: Record<string, {
    suggested_value: unknown;
    confidence: number;
    policy: 'autofill' | 'suggest_only' | 'no_prefill';
    evidence: { source_url: string; excerpt: string }[];
  }>;
  question_overrides?: Record<string, {
    label_override: string;
    help_override?: string;
    ui_pattern: 'confirmation' | 'default';
    original_label: string;
  }>;
  branding?: {
    screenshot_url?: string;
    logo_url?: string;
    colors?: string[];
    fonts?: string[];
  };
  insights?: {
    brand_name?: string;
    business_summary?: string;
    primary_services?: { name: string; confidence: number }[];
    secondary_services?: { name: string; confidence: number }[];
    primary_locations?: { name: string; type: string; confidence: number }[];
    secondary_locations?: { name: string; type: string; confidence: number }[];
    contact_public?: { phone?: string; email?: string; address?: string };
    social_links?: { platform: string; url: string }[];
    key_pages?: { url: string; title: string; reason: string }[];
  };
}

interface WizardProps {
  token: string;
  initialStep: number;
  initialAnswers: Record<string, { answers: Record<string, unknown>; completed: boolean }>;
  sessionStatus: 'draft' | 'in_progress' | 'submitted';
  flowVersion?: 'v1' | 'v2';
  clientName?: string;
  contactName?: string;
  /**
   * Stage 7 / P3+P4: when true, the first-login welcome modal has
   * already been dismissed for this session. Gates BOTH the modal
   * itself (only fires once per session, server-tracked) AND the
   * P4 returning-user greeting (which uses the company name and
   * only surfaces from the second login onward).
   */
  welcomeWizardSeen?: boolean;
  /**
   * Stage 8 / S12.2: rendered in the rebuilt thank-you screen copy.
   * Pulled from `onboarding_sessions.account_manager` (set during admin
   * Create — Stage 1 / P1). Null on legacy rows; ThankYou falls back to
   * "your account manager" in that case.
   */
  accountManager?: string | null;
  /**
   * Stage 9 / home-services PR: drives Step 7 branching and per-vertical
   * copy. Defaults to 'law_firm' for backwards compat — every existing
   * session row was law_firm by virtue of the migration 005 default.
   */
  vertical?: VerticalId;
  siteIntelligence?: SiteIntelligenceData | null;
}

export default function Wizard({
  token,
  initialStep,
  initialAnswers,
  sessionStatus,
  flowVersion = 'v1',
  clientName = '',
  contactName = '',
  welcomeWizardSeen = true,
  accountManager = null,
  vertical = 'law_firm',
  siteIntelligence = null,
}: WizardProps) {
  const steps = useMemo(() => getStepsForVersion(flowVersion), [flowVersion]);
  // Defensive clamp against an out-of-bounds session.current_step (the
  // goarco production smoke surfaced this — `steps[12]` is undefined
  // when a 12-step session has current_step=12, which the submit
  // handler sets on submit and an admin-driven rollback could leave
  // behind). Pure helper in src/lib/onboarding/wizard-state.ts.
  const [currentStepIndex, setCurrentStepIndex] = useState(() =>
    clampInitialStep(initialStep, steps.length)
  );
  const [answers, setAnswers] = useState<Record<string, Record<string, unknown>>>(() => {
    const initial: Record<string, Record<string, unknown>> = {};
    Object.entries(initialAnswers).forEach(([key, value]) => {
      initial[key] = value.answers;
    });
    return initial;
  });
  const [completedStepsState, setCompletedStepsState] = useState<string[]>(() => {
    return Object.entries(initialAnswers)
      .filter(([, value]) => value.completed)
      .map(([key]) => key);
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showSnapshot, setShowSnapshot] = useState(!!siteIntelligence?.insights);

  // Step transition state
  const [transitioning, setTransitioning] = useState(false);
  const [contentVisible, setContentVisible] = useState(false); // start hidden for welcome
  const [transitionMessage, setTransitionMessage] = useState<TransitionMessage | null>(null);
  const pendingStepRef = useRef<number | null>(null);
  const pendingSubmitRef = useRef(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [isSubmitted, setIsSubmitted] = useState(sessionStatus === 'submitted');
  const [showWelcome, setShowWelcome] = useState(true);

  // G2: click guard against icon-nav races. `isNavigating` covers the brief
  // window between click → render → background save settle so the form card
  // shows a skeleton instead of a "white card flash" and so back-to-back
  // clicks can't race their save-promises to overwrite `currentStepIndex`.
  // `lastNavClickRef` is a 150ms hard floor on click rate, matching the
  // operator's latency target.
  const [isNavigating, setIsNavigating] = useState(false);
  const lastNavClickRef = useRef(0);

  // Scroll navigation state
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(true);

  const currentStep = steps[currentStepIndex];
  const stepAnswers = answers[currentStep?.key] || {};

  // Derive personalized names for interstitial messages
  const contactFirstName = useMemo(() => {
    // Prefer the name from answers if filled in, otherwise use session data
    const fromAnswers = answers['primary_contact']?.main_contact_name as string | undefined;
    const name = fromAnswers || contactName || '';
    return name.split(' ')[0] || '';
  }, [answers, contactName]);

  const businessName = useMemo(() => {
    // V1 uses business_basics, V2 uses business_overview
    const fromV1 = answers['business_basics']?.business_name as string | undefined;
    const fromV2 = answers['business_overview']?.business_name as string | undefined;
    return fromV1 || fromV2 || clientName || '';
  }, [answers, clientName]);

  // Apply site intelligence prefill on mount (only to empty fields, only once)
  useEffect(() => {
    if (!siteIntelligence?.prefill_map) return;
    const prefillMap = siteIntelligence.prefill_map;

    setAnswers(prev => {
      const updated = { ...prev };
      for (const [fieldKey, entry] of Object.entries(prefillMap)) {
        if (entry.policy !== 'autofill') continue;

        // Find which step this field belongs to
        for (const step of steps) {
          const field = step.fields.find(f => f.name === fieldKey);
          if (!field) continue;

          const stepKey = step.key;
          const currentValue = updated[stepKey]?.[fieldKey];

          // Only prefill if the field is currently empty
          const isEmpty = currentValue === undefined || currentValue === null || currentValue === '' ||
            (Array.isArray(currentValue) && currentValue.length === 0);

          if (isEmpty) {
            updated[stepKey] = {
              ...updated[stepKey],
              [fieldKey]: entry.suggested_value,
            };
          }
          break;
        }
      }
      return updated;
    });
  }, []); // Only run once on mount

  // P4 (Stage 7): once the P3 modal has been dismissed, every subsequent
  // visit is a "returning" visit by definition. The previous heuristic
  // (initialStep > 0 || initialAnswers.length > 0) failed for users who
  // dismissed the modal but quit before filling anything in. The flag is
  // the right signal.
  const isReturning = useMemo(() => {
    if (welcomeWizardSeen) return true;
    return initialStep > 0 || Object.keys(initialAnswers).length > 0;
  }, [welcomeWizardSeen, initialStep, initialAnswers]);

  // P3 (Stage 7): first-login welcome wizard modal. Two-step popover
  // that replaces the green interstitial on the very first PIN-authed
  // session load. Gated on welcomeWizardSeen (server-tracked) so it
  // truly only ever fires once per session — surviving cleared cookies.
  // Local `welcomeModalOpen` lets the user dismiss within this render
  // before the server flag round-trip completes.
  const [welcomeModalOpen, setWelcomeModalOpen] = useState(!welcomeWizardSeen && sessionStatus !== 'submitted');
  const showP3Modal = welcomeModalOpen;

  useEffect(() => {
    // If we're going to show the P3 modal, skip the legacy green
    // interstitial entirely (it would just play behind the modal).
    if (showP3Modal) {
      setContentVisible(true);
      setShowWelcome(false);
      return;
    }

    if (!showWelcome || isSubmitted) {
      setContentVisible(true);
      return;
    }

    // P4 (Stage 7): use the CLIENT COMPANY NAME, not the personal
    // contact's first name. Only fires when welcomeWizardSeen=true
    // (the P3 modal handled the first login). The fallback to
    // contact first name preserves a sensible greeting for legacy
    // sessions where clientName isn't populated.
    const greetingName = clientName || (contactName ? contactName.split(' ')[0] : '');
    const welcomeMsg = getWelcomeMessage(greetingName, isReturning);
    setTransitionMessage(welcomeMsg);
    setTransitioning(true);

    // Welcome will auto-dismiss via handleTransitionDone
  }, []); // Only run on mount

  // Calculate missing required fields
  const missingFields = useMemo(() => {
    return getMissingRequiredFieldsForVersion(flowVersion, answers, vertical);
  }, [answers, flowVersion, vertical]);

  // Check if all required fields are complete (for blocking submission)
  const canSubmit = missingFields.length === 0;

  // Group missing fields by step
  const missingFieldsByStep = useMemo(() => {
    const grouped: Record<string, { stepTitle: string; stepIndex: number; fields: { fieldName: string; fieldLabel: string }[] }> = {};
    missingFields.forEach((field) => {
      if (!grouped[field.stepKey]) {
        grouped[field.stepKey] = {
          stepTitle: field.stepTitle,
          stepIndex: field.stepIndex,
          fields: [],
        };
      }
      grouped[field.stepKey].fields.push({
        fieldName: field.fieldName,
        fieldLabel: field.fieldLabel,
      });
    });
    return grouped;
  }, [missingFields]);

  // Handle field change
  const handleFieldChange = useCallback((name: string, value: unknown) => {
    setAnswers((prev) => ({
      ...prev,
      [currentStep.key]: {
        ...prev[currentStep.key],
        [name]: value,
      },
    }));
    // Clear error for this field
    setErrors((prev) => {
      const newErrors = { ...prev };
      delete newErrors[name];
      return newErrors;
    });
    setSaveError(null);
  }, [currentStep?.key]);

  // Save step to server
  const saveStep = async (completed: boolean): Promise<boolean> => {
    setIsSaving(true);
    setSaveError(null);

    try {
      const response = await fetch('/api/public/onboarding/save-step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          stepKey: currentStep.key,
          stepIndex: currentStepIndex,
          answers: stepAnswers,
          completed,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        if (data.validationErrors) {
          setErrors(data.validationErrors);
        }
        throw new Error(data.error || 'Failed to save');
      }

      if (completed && !completedStepsState.includes(currentStep.key)) {
        setCompletedStepsState((prev) => [...prev, currentStep.key]);
      }

      setLastSaved(new Date());
      return true;
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Failed to save. Please try again.');
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  // Stage 10 / Fix 4: properly sequence the page-swap so it's invisible
  // to the user. Pre-fix sequence was:
  //   t=0      content fade out begins (500ms)
  //   t=200ms  STEP SWAP + splash starts fading in (400ms)
  //   t=600ms  splash fully opaque
  // The 200-600ms window had the new step rendered behind a half-opaque
  // splash + half-faded-out old content — the operator saw the new
  // content "peek" through. Post-fix sequence:
  //   t=0      splash starts fading in (400ms), old content stays at
  //            opacity 1 — it's behind the splash and getting hidden.
  //   t=450ms  StepTransition fires onCovered. We swap the step + reset
  //            scroll under cover. User sees nothing.
  //   t=1700ms splash starts fading out.
  //   t=2100ms onDone → clear transitioning state, new step is visible.
  const startTransition = useCallback((targetStep: number, message: TransitionMessage) => {
    if (transitioning) return;
    pendingStepRef.current = targetStep;
    setTransitionMessage(message);
    setTransitioning(true);             // splash starts fading in immediately
    // No setContentVisible(false) — the splash covers the content; we
    // don't need to fade the underlying step out in parallel.
  }, [transitioning]);

  // Stage 10 / Fix 4: fires when the splash reaches 100% opacity. Safe
  // to mutate currentStepIndex / scroll position here — the user can't
  // see any of it. No-op when there's no pending step (the first-load
  // welcome interstitial uses the same component but doesn't swap any
  // step; pendingStepRef.current stays null in that case).
  const handleCoverComplete = useCallback(() => {
    const target = pendingStepRef.current;
    if (target !== null) {
      setCurrentStepIndex(target);
      setErrors({});
      // Instant scroll — `behavior: 'smooth'` here would animate after
      // the splash starts fading out, defeating the whole point.
      window.scrollTo({ top: 0 });
    }
  }, []);

  // Called when the interstitial finishes (after fade-out completes)
  const handleTransitionDone = useCallback(() => {
    setTransitioning(false);
    setTransitionMessage(null);
    setContentVisible(true);            // first-load welcome reveal still uses this
    setShowWelcome(false);
    pendingStepRef.current = null;

    // If we were submitting, do that now
    if (pendingSubmitRef.current) {
      pendingSubmitRef.current = false;
    }
  }, []);

  // Handle next step
  const handleNext = async () => {
    // Skip validation for review step
    if (!currentStep.isReviewStep) {
      const validation = validateStepDataForVersion(flowVersion, currentStep.key, stepAnswers);
      if (!validation.success && validation.errors) {
        setErrors(validation.errors);
        return;
      }
    }

    // Save with completed = true
    const saved = await saveStep(true);

    if (!saved) {
      return;
    }

    // Show cheerleading interstitial and advance
    if (currentStepIndex < steps.length - 1) {
      const nextStep = steps[currentStepIndex + 1];
      const message = getTransitionMessage(
        currentStep.key,
        nextStep.title,
        contactFirstName,
        businessName,
        answers,
        flowVersion,
      );
      startTransition(currentStepIndex + 1, message);
    }
  };

  // Handle previous step (simple fade, no interstitial)
  const handlePrevious = () => {
    if (currentStepIndex > 0 && !transitioning) {
      setErrors({});
      setContentVisible(false);
      setTimeout(() => {
        setCurrentStepIndex(currentStepIndex - 1);
        setContentVisible(true);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }, 300);
    }
  };

  // Handle save and exit
  const handleSaveAndExit = async () => {
    await saveStep(false);
    // Could redirect to a "saved" page or show a message
  };

  // Handle submit
  const handleSubmit = async () => {
    // Block submission if there are missing required fields
    if (!canSubmit) {
      setSaveError('Please complete all required fields before submitting. Go back to the "Almost There" step to see what\'s missing.');
      return;
    }

    // Validate final step
    const validation = validateStepDataForVersion(flowVersion, currentStep.key, stepAnswers);
    if (!validation.success && validation.errors) {
      setErrors(validation.errors);
      return;
    }

    // Save final step first
    const saved = await saveStep(true);

    if (!saved) {
      return;
    }

    // Submit the session
    try {
      const response = await fetch('/api/public/onboarding/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to submit');
      }

      setIsSubmitted(true);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Failed to submit. Please try again.');
    }
  };

  // Auto-save on every change (short debounce to handle rapid typing)
  // Preserves completed status - never downgrades a completed step
  const pendingSaveRef = useRef(false);

  useEffect(() => {
    // Mark that we have pending changes
    pendingSaveRef.current = true;

    const timeout = setTimeout(() => {
      if (Object.keys(stepAnswers).length > 0 && !isSaving && !currentStep.isReviewStep && pendingSaveRef.current) {
        pendingSaveRef.current = false;
        const isAlreadyCompleted = completedStepsState.includes(currentStep.key);
        saveStep(isAlreadyCompleted);
      }
    }, 800); // Save after 800ms of inactivity - quick enough to feel instant

    return () => clearTimeout(timeout);
  }, [stepAnswers]);

  // Navigate to step - allow navigation to any step.
  //
  // G2 fix: the original code awaited `saveStep` before calling
  // `setCurrentStepIndex`, which meant two rapid clicks raced their
  // save-promises and either click could win — to the user that looked
  // like an off-by-one bug. Now we navigate the UI synchronously and
  // fire the save in the background. The save closure captures the
  // outgoing step's key/index/answers so the POST body is still correct
  // even though state has already advanced.
  const navigateToStep = (index: number) => {
    if (index === currentStepIndex) return;

    // Click guard: drop clicks while another nav is settling, while the
    // step-advance interstitial is on screen, or within 150ms of the
    // previous click.
    if (isNavigating || transitioning) return;
    const now = Date.now();
    if (now - lastNavClickRef.current < 150) return;
    lastNavClickRef.current = now;

    const shouldSave =
      Object.keys(stepAnswers).length > 0 && !currentStep.isReviewStep;
    const isAlreadyCompleted = completedStepsState.includes(currentStep.key);

    setIsNavigating(true);
    setCurrentStepIndex(index);
    setErrors({});
    window.scrollTo({ top: 0, behavior: 'smooth' });

    if (shouldSave) {
      // Fire-and-forget. saveStep's closure still references the OLD
      // currentStep/currentStepIndex/stepAnswers since the save is invoked
      // from this render's scope before React commits the new state.
      saveStep(isAlreadyCompleted).finally(() => setIsNavigating(false));
    } else {
      // No save needed — release the guard after a brief skeleton flash
      // so the user sees motion feedback rather than an instant swap.
      setTimeout(() => setIsNavigating(false), 150);
    }
  };

  // Calculate progress percentage
  const progressPercentage = ((currentStepIndex + 1) / steps.length) * 100;
  const completedPercentage = (completedStepsState.length / steps.length) * 100;

  // Update scroll indicators
  const updateScrollIndicators = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const { scrollLeft, scrollWidth, clientWidth } = container;
    setCanScrollLeft(scrollLeft > 5);
    setCanScrollRight(scrollLeft < scrollWidth - clientWidth - 5);
  }, []);

  // Scroll navigation handlers
  const scrollNav = useCallback((direction: 'left' | 'right') => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const scrollAmount = 200;
    container.scrollBy({
      left: direction === 'left' ? -scrollAmount : scrollAmount,
      behavior: 'smooth',
    });
  }, []);

  // Scroll current step into view on mount and step change
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    // Find the current step button and scroll it into view
    const buttons = container.querySelectorAll('button');
    const currentButton = buttons[currentStepIndex];
    if (currentButton) {
      currentButton.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }

    // Update scroll indicators after scrolling
    const timer = setTimeout(updateScrollIndicators, 300);
    return () => clearTimeout(timer);
  }, [currentStepIndex, updateScrollIndicators]);

  // Add scroll event listener
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    container.addEventListener('scroll', updateScrollIndicators);
    updateScrollIndicators(); // Initial check

    return () => container.removeEventListener('scroll', updateScrollIndicators);
  }, [updateScrollIndicators]);

  // Stage 8: rebuilt thank-you screen. Confetti + pop animation + new
  // copy (S12.1 + S12.2 + S12.3 + S12.4) + star rating + Finish CTA all
  // live in <ThankYou />. We hand it the Step-3 business name where
  // available (clients fill that during the form) and fall back to the
  // client_name set at session creation; the account manager is server-
  // sourced (see OnboardingShell prop plumbing) with a friendly default
  // when null on legacy rows.
  if (isSubmitted) {
    const companyName = businessName || clientName || '';
    const amName = accountManager?.trim() || '';
    return <ThankYou companyName={companyName} accountManagerName={amName} token={token} />;
  }

  // Render "Almost There" review step
  const renderAlmostThereStep = () => {
    const hasMissingFields = missingFields.length > 0;

    return (
      <div className="space-y-6">
        {hasMissingFields ? (
          <>
            <div className="text-center mb-8">
              <div className="w-16 h-16 mx-auto mb-4 bg-[#F5A524]/10 rounded-full flex items-center justify-center">
                <svg className="w-8 h-8 text-[#F5A524]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <h2 className="text-xl font-bold text-[#0B0B0B] mb-2">
                A few things need your attention
              </h2>
              <p className="text-[#6B6B6B]">
                Please complete the following required fields before submitting.
              </p>
            </div>

            <div className="space-y-4">
              {Object.entries(missingFieldsByStep).map(([stepKey, { stepTitle, stepIndex, fields }]) => (
                <div
                  key={stepKey}
                  className="bg-[#FEF3C7] border border-[#F5A524]/30 rounded-lg p-4 cursor-pointer hover:bg-[#FDE68A] transition-colors"
                  onClick={() => navigateToStep(stepIndex)}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="font-semibold text-[#92400E] mb-1">{stepTitle}</h3>
                      <ul className="text-sm text-[#B45309]">
                        {fields.map((field) => (
                          <li key={field.fieldName} className="flex items-center gap-2">
                            <span className="w-1.5 h-1.5 bg-[#F5A524] rounded-full"></span>
                            {field.fieldLabel}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <svg className="w-5 h-5 text-[#92400E]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="text-center mb-8">
              <div className="w-16 h-16 mx-auto mb-4 bg-[#25DC7F]/10 rounded-full flex items-center justify-center">
                <svg className="w-8 h-8 text-[#25DC7F]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h2 className="text-xl font-bold text-[#0B0B0B] mb-2">
                All required fields are complete!
              </h2>
              <p className="text-[#6B6B6B]">
                You&apos;re ready to proceed to the final step.
              </p>
            </div>

            <div className="bg-[#ECFDF5] border border-[#25DC7F]/30 rounded-lg p-6 text-center">
              <p className="text-[#065F46] font-medium">
                Click &quot;Next&quot; to review and submit your onboarding information.
              </p>
            </div>
          </>
        )}
      </div>
    );
  };

  return (
    <>
      {/* P3 (Stage 7): first-login welcome modal. Mounted before the
          step interstitial so it sits on top of any in-flight transition
          and the user always sees the welcome FIRST on a fresh session. */}
      {showP3Modal && (
        <WelcomeModal
          companyName={clientName}
          token={token}
          onDismiss={() => setWelcomeModalOpen(false)}
        />
      )}

      {/* Step Transition Interstitial */}
      <StepTransition
        active={transitioning}
        message={transitionMessage}
        onCovered={handleCoverComplete}
        onDone={handleTransitionDone}
      />

      <div className="min-h-screen bg-[#F4F5F6] flex flex-col">
        {/* Header */}
        <header className="bg-[#0F1A14]">
          <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
            <img src={CLIXSY_LOGO_URL} alt="Clixsy" className="h-8" />
            <div className="px-4 py-2 bg-[#1A2A1F] text-white text-sm font-semibold rounded-lg">
              Clixsy Onboarding Portal
            </div>
          </div>

          {/* Progress Bar & Step Navigator */}
          <div className="max-w-6xl mx-auto px-4 sm:px-6 pb-4">
            {/* Progress Bar */}
            <div className="mb-4">
              <div className="flex items-center justify-between text-sm text-[#A0A0A0] mb-2">
                <span>Step {currentStepIndex + 1} of {steps.length}</span>
                <span>{Math.round(completedPercentage)}% complete</span>
              </div>
              <div className="h-2 bg-[#1A2A1F] rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#25DC7F] transition-all duration-300"
                  style={{ width: `${progressPercentage}%` }}
                />
              </div>
            </div>

            {/* Icon Step Navigator with scroll controls */}
            <div className="relative flex items-center justify-center">
              {/* Left scroll button */}
              <button
                onClick={() => scrollNav('left')}
                className={`absolute left-0 z-10 flex items-center justify-center w-8 h-10 bg-gradient-to-r from-[#0F1A14] via-[#0F1A14] to-transparent transition-opacity ${
                  canScrollLeft ? 'opacity-100' : 'opacity-0 pointer-events-none'
                }`}
                aria-label="Scroll left"
              >
                <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>

              {/* Left fade indicator */}
              <div className={`absolute left-8 top-0 bottom-0 w-8 bg-gradient-to-r from-[#0F1A14] to-transparent z-[5] pointer-events-none transition-opacity ${
                canScrollLeft ? 'opacity-100' : 'opacity-0'
              }`} />

              {/* Scrollable container. Stage 10 / Fix 3 added snap-x +
                  snap-center so finger-swipes land cleanly on an icon.
                  Stage 12 / Fix 1: justify-center on overflow (mobile)
                  was centring the wider-than-viewport icon row, which
                  put the first icon off-screen to the LEFT at scrollLeft=0.
                  scrollIntoView couldn't fully recover because scrollLeft
                  can't go negative — icon 0 stayed clipped. Switching
                  to justify-start on mobile keeps the first icon at the
                  natural left edge (with the existing px-10 buffer
                  reserving room for the chevron + fade overlays). On
                  sm+ where the 12 icons usually fit, justify-center
                  preserves the centered desktop look. */}
              <div
                ref={scrollContainerRef}
                className="flex items-center justify-start sm:justify-center gap-2 overflow-x-auto px-10 py-2 scroll-smooth hide-scrollbar w-full snap-x snap-mandatory"
              >
                {steps.map((step, index) => {
                  const isCompleted = completedStepsState.includes(step.key);
                  const isCurrent = index === currentStepIndex;

                  return (
                    <button
                      key={step.key}
                      onClick={() => navigateToStep(index)}
                      disabled={isNavigating}
                      aria-current={isCurrent ? 'step' : undefined}
                      className={`group relative flex-shrink-0 snap-center w-10 h-10 rounded-lg transition-all cursor-pointer flex items-center justify-center ${
                        isCompleted
                          ? 'bg-[#25DC7F] text-white'
                          : isCurrent
                          ? 'bg-white text-[#0F1A14] ring-2 ring-[#25DC7F]'
                          : 'bg-[#1A2A1F] text-[#569077] hover:bg-[#25DC7F]/20 hover:text-[#25DC7F]'
                      } ${isNavigating ? 'opacity-90 cursor-wait' : ''}`}
                      title={step.title}
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d={step.icon} />
                      </svg>
                      {/* G1: active-step underline pill — sits just below the
                          icon button, picks up the existing green accent. */}
                      <span
                        aria-hidden
                        className={`pointer-events-none absolute -bottom-1.5 left-1/2 -translate-x-1/2 h-1 rounded-full transition-all duration-200 ${
                          isCurrent ? 'w-6 bg-[#25DC7F]' : 'w-0 bg-transparent'
                        }`}
                      />
                      {/* Tooltip */}
                      <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-[#0B0B0B] text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-20">
                        {step.title}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Right fade indicator */}
              <div className={`absolute right-8 top-0 bottom-0 w-8 bg-gradient-to-l from-[#0F1A14] to-transparent z-[5] pointer-events-none transition-opacity ${
                canScrollRight ? 'opacity-100' : 'opacity-0'
              }`} />

              {/* Right scroll button */}
              <button
                onClick={() => scrollNav('right')}
                className={`absolute right-0 z-10 flex items-center justify-center w-8 h-10 bg-gradient-to-l from-[#0F1A14] via-[#0F1A14] to-transparent transition-opacity ${
                  canScrollRight ? 'opacity-100' : 'opacity-0 pointer-events-none'
                }`}
                aria-label="Scroll right"
              >
                <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>
        </header>

        {/* Main Content */}
        <main
          className="flex-1 max-w-4xl w-full mx-auto px-4 py-6"
          style={{
            opacity: contentVisible ? 1 : 0,
            transform: contentVisible ? 'translateY(0)' : 'translateY(12px)',
            transition: 'opacity 0.5s ease, transform 0.5s ease',
          }}
        >
          {/* Website Snapshot (shown on first step only) */}
          {showSnapshot && currentStepIndex === 0 && siteIntelligence && (
            <WebsiteSnapshot
              branding={siteIntelligence.branding}
              insights={siteIntelligence.insights}
              onDismiss={() => setShowSnapshot(false)}
            />
          )}

          {/* Step Title */}
          <div className="text-center mb-4">
            <h1 className="text-2xl font-extrabold text-[#0B0B0B] mb-1">
              {currentStep.title}
            </h1>
            <p className="text-[#6B6B6B] text-sm">
              {currentStep.description}
            </p>
          </div>

          {/* Content Card */}
          <div className="bg-white rounded-xl shadow-sm border border-[#E6E8EA] p-6">
            {/* Error Banner */}
            {saveError && (
              <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
                <div className="flex items-center gap-2">
                  <svg className="w-5 h-5 text-[#E5484D]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span className="text-[#E5484D]">{saveError}</span>
                </div>
                <button
                  onClick={() => setSaveError(null)}
                  className="mt-2 text-sm text-[#E5484D] hover:underline"
                >
                  Dismiss
                </button>
              </div>
            )}

            {/* Step Content — skeleton fallback shown while a step swap
                is in flight so the form card is never blank (acceptance
                criterion: user always sees content or a skeleton, never
                an empty white card). */}
            {isNavigating ? (
              <div className="space-y-5" aria-busy="true" aria-live="polite">
                <div className="h-5 w-1/3 rounded bg-[#E6E8EA] animate-pulse" />
                <div className="h-10 w-full rounded bg-[#E6E8EA] animate-pulse" />
                <div className="h-5 w-1/2 rounded bg-[#E6E8EA] animate-pulse" />
                <div className="h-10 w-full rounded bg-[#E6E8EA] animate-pulse" />
                <div className="h-5 w-1/4 rounded bg-[#E6E8EA] animate-pulse" />
                <div className="h-24 w-full rounded bg-[#E6E8EA] animate-pulse" />
                <span className="sr-only">Loading step content…</span>
              </div>
            ) : currentStep.key === 'access_checklist' ? (
              <AccessChecklistStep
                values={stepAnswers}
                errors={errors}
                onChange={handleFieldChange}
              />
            ) : currentStep.isReviewStep ? (
              renderAlmostThereStep()
            ) : (
              <StepRenderer
                step={currentStep}
                values={stepAnswers}
                errors={errors}
                onChange={handleFieldChange}
                questionOverrides={siteIntelligence?.question_overrides}
                prefillMap={siteIntelligence?.prefill_map}
                vertical={vertical}
              />
            )}
          </div>
        </main>

        {/* Footer Navigation */}
        <footer className="sticky bottom-0 bg-white border-t border-[#E6E8EA] py-4 px-4">
          <div className="max-w-4xl mx-auto flex items-center justify-between">
            {/* Back Button */}
            <button
              onClick={handlePrevious}
              disabled={currentStepIndex === 0 || transitioning}
              className={`flex items-center gap-2 px-6 py-3 rounded-lg font-semibold transition-all ${
                currentStepIndex === 0 || transitioning
                  ? 'text-[#A0A0A0] cursor-not-allowed'
                  : 'text-[#0B0B0B] border border-[#E6E8EA] hover:bg-[#F4F5F6]'
              }`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Back
            </button>

            {/* Save Status Indicator */}
            <div className="flex items-center gap-3">
              {isSaving ? (
                <span className="flex items-center gap-2 text-sm text-[#6B6B6B]">
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Saving...
                </span>
              ) : lastSaved ? (
                <span className="flex items-center gap-2 text-sm text-[#25DC7F]">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Saved
                </span>
              ) : null}
            </div>

            {/* Next/Submit Button. Stage 11 / Fix 1: the disabled
                "Complete All Fields" copy was wrapping to two lines on
                Android (~360px) — the green check ended up below the
                text. Reduced horizontal padding on mobile + shorter
                "Complete" copy on sm-and-below + whitespace-nowrap so
                it never wraps regardless of viewport. Desktop sees the
                full "Complete All Fields" still. */}
            {currentStepIndex === steps.length - 1 ? (
              <button
                onClick={handleSubmit}
                disabled={isSaving || !canSubmit || transitioning}
                className={`flex items-center gap-2 px-5 sm:px-8 py-3 rounded-lg font-semibold transition-all whitespace-nowrap ${
                  canSubmit
                    ? 'bg-[#25DC7F] text-white hover:bg-[#1DB96A]'
                    : 'bg-gray-300 text-gray-500 cursor-not-allowed'
                } disabled:opacity-50`}
              >
                {isSaving ? (
                  'Submitting...'
                ) : canSubmit ? (
                  'Submit'
                ) : (
                  <>
                    <span className="sm:hidden">Complete</span>
                    <span className="hidden sm:inline">Complete All Fields</span>
                  </>
                )}
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </button>
            ) : (
              <button
                onClick={handleNext}
                disabled={isSaving || transitioning}
                className="flex items-center gap-2 px-5 sm:px-8 py-3 bg-[#25DC7F] text-white rounded-lg font-semibold hover:bg-[#1DB96A] transition-all disabled:opacity-50 whitespace-nowrap"
              >
                Next
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            )}
          </div>
        </footer>
      </div>
    </>
  );
}
