import OnboardingShell from '@/components/onboarding/OnboardingShell';

interface OnboardingPageProps {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ am?: string }>;
}

/**
 * Stage 7: the page is now a thin server-component shell. All session
 * data loading + PIN gating happens client-side in OnboardingShell so
 * that:
 *   1. The PIN cookie can be set by the verify-pin endpoint and read on
 *      the subsequent fetch in the same render lifecycle (a server
 *      render can't see a cookie set by a fetch it kicked off).
 *   2. The page never renders an authenticated view server-side for a
 *      user who hasn't yet entered their PIN — eliminating the "form
 *      flashed briefly before redirecting to PIN" failure mode.
 */
export default async function OnboardingPage({ params, searchParams }: OnboardingPageProps) {
  const { token } = await params;
  // Sprint 2 / #4: AM-bypass signature rides the `am` query param. Passed
  // through verbatim — verification is server-side in every API route.
  const { am } = await searchParams;
  return <OnboardingShell token={token} amToken={am ?? null} />;
}

export async function generateMetadata() {
  return {
    title: 'Client Onboarding',
    description: 'Complete your onboarding to get started',
  };
}
