import { notFound } from 'next/navigation';
import Wizard from '@/components/onboarding/Wizard';

interface OnboardingPageProps {
  params: Promise<{ token: string }>;
}

async function getSessionData(token: string) {
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';

  try {
    const response = await fetch(`${baseUrl}/api/public/onboarding/session?token=${token}`, {
      cache: 'no-store',
    });

    if (!response.ok) {
      return null;
    }

    return response.json();
  } catch (error) {
    console.error('Error fetching session:', error);
    return null;
  }
}

export default async function OnboardingPage({ params }: OnboardingPageProps) {
  const { token } = await params;
  const data = await getSessionData(token);

  if (!data) {
    notFound();
  }

  return (
    <Wizard
      token={token}
      initialStep={data.session.currentStep}
      initialAnswers={data.answers}
      sessionStatus={data.session.status}
      flowVersion={data.session.flowVersion || 'v1'}
      clientName={data.client?.name || ''}
      contactName={data.client?.contactName || ''}
      siteIntelligence={data.siteIntelligence || null}
    />
  );
}

export async function generateMetadata({ params }: OnboardingPageProps) {
  return {
    title: 'Client Onboarding',
    description: 'Complete your onboarding to get started',
  };
}
