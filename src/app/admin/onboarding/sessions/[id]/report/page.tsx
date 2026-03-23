'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

const CLIXSY_LOGO_URL = 'https://res.cloudinary.com/dovgh19xr/image/upload/v1766427227/new_logo_nvrux0.svg';

interface WorkOrderTask {
  key: string;
  title: string;
  owner: string;
  status: string;
  category: string;
}

interface ReportData {
  session: {
    id: string;
    status: string;
    submittedAt: string;
  };
  client: {
    name: string;
    contactName: string;
  };
  answers: Record<string, { answers: Record<string, unknown> }>;
  siteIntelligence: {
    branding?: { screenshot_url?: string; colors?: string[]; fonts?: string[] };
    insights?: {
      brand_name?: string;
      business_summary?: string;
      primary_services?: { name: string }[];
      primary_locations?: { name: string }[];
    };
  } | null;
  sopRouting: {
    big5: Record<string, string>;
    required_sops: string[];
    notes: string;
  } | null;
  workOrder: {
    tasks: WorkOrderTask[];
    final_report_status: string;
    generated_at: string;
  } | null;
}

export default function FinalReportPage() {
  const params = useParams();
  const sessionId = params.id as string;
  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        // Fetch session details
        const sessionRes = await fetch(`/api/admin/onboarding/sessions/${sessionId}`);
        if (!sessionRes.ok) throw new Error('Failed to load session');
        const sessionData = await sessionRes.json();

        // Fetch SOP routing
        const sopRes = await fetch(`/api/admin/sop-routing?sessionId=${sessionId}`);
        const sopData = await sopRes.json();

        // Fetch work order
        const woRes = await fetch(`/api/admin/work-orders?sessionId=${sessionId}`);
        const woData = await woRes.json();

        setData({
          session: sessionData.session,
          client: sessionData.client,
          answers: sessionData.answers,
          siteIntelligence: sessionData.siteIntelligence || null,
          sopRouting: sopData.routing || null,
          workOrder: woData.workOrder || null,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load report');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [sessionId]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#F4F5F6] flex items-center justify-center">
        <div className="text-[#6B6B6B]">Loading report...</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-[#F4F5F6] flex items-center justify-center">
        <div className="text-[#E5484D]">{error || 'No data available'}</div>
      </div>
    );
  }

  const onboardingTasks = data.workOrder?.tasks.filter(t => t.category === 'onboarding') || [];
  const sopTasks = data.workOrder?.tasks.filter(t => t.category === 'sop') || [];

  return (
    <div className="min-h-screen bg-[#F4F5F6]">
      {/* Header */}
      <header className="bg-[#0F1A14] print:bg-white print:border-b">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/admin/onboarding/sessions">
            <img src={CLIXSY_LOGO_URL} alt="Clixsy" className="h-8 print:hidden" />
          </Link>
          <div className="flex items-center gap-3">
            <button
              onClick={() => window.print()}
              className="px-4 py-2 bg-[#25DC7F] text-white text-sm font-semibold rounded-lg hover:bg-[#1DB96A] print:hidden"
            >
              Print / Export PDF
            </button>
            <div className="px-4 py-2 bg-[#1A2A1F] text-white text-sm font-semibold rounded-lg print:bg-transparent print:text-black">
              Onboarding Final Report
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-8">
        {/* Report Title */}
        <div className="text-center">
          <h1 className="text-3xl font-extrabold text-[#0B0B0B] mb-2">
            Onboarding Final Report
          </h1>
          <p className="text-[#6B6B6B]">
            {data.client.name} &mdash; {data.session.submittedAt ? new Date(data.session.submittedAt).toLocaleDateString() : 'Pending'}
          </p>
          <p className="text-xs text-[#A0A0A0] mt-1">Report: Sunset</p>
        </div>

        {/* Website Snapshot Section */}
        {data.siteIntelligence && (
          <section className="bg-white rounded-xl border border-[#E6E8EA] p-6">
            <h2 className="text-lg font-bold text-[#0B0B0B] mb-4">Website Snapshot</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {data.siteIntelligence.branding?.screenshot_url && (
                <div className="rounded-lg overflow-hidden border border-[#E6E8EA]">
                  <img
                    src={data.siteIntelligence.branding.screenshot_url}
                    alt="Website screenshot"
                    className="w-full h-auto"
                  />
                </div>
              )}
              <div className="space-y-3">
                {data.siteIntelligence.insights?.brand_name && (
                  <div>
                    <span className="text-xs font-semibold text-[#6B6B6B] uppercase">Brand</span>
                    <p className="text-sm font-medium">{data.siteIntelligence.insights.brand_name}</p>
                  </div>
                )}
                {data.siteIntelligence.insights?.business_summary && (
                  <div>
                    <span className="text-xs font-semibold text-[#6B6B6B] uppercase">Summary</span>
                    <p className="text-sm">{data.siteIntelligence.insights.business_summary}</p>
                  </div>
                )}
                {data.siteIntelligence.insights?.primary_services && data.siteIntelligence.insights.primary_services.length > 0 && (
                  <div>
                    <span className="text-xs font-semibold text-[#6B6B6B] uppercase">Services</span>
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {data.siteIntelligence.insights.primary_services.map((s, i) => (
                        <span key={i} className="px-2 py-0.5 bg-[#25DC7F]/10 rounded-full text-xs">{s.name}</span>
                      ))}
                    </div>
                  </div>
                )}
                {data.siteIntelligence.insights?.primary_locations && data.siteIntelligence.insights.primary_locations.length > 0 && (
                  <div>
                    <span className="text-xs font-semibold text-[#6B6B6B] uppercase">Markets</span>
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {data.siteIntelligence.insights.primary_locations.map((l, i) => (
                        <span key={i} className="px-2 py-0.5 bg-blue-50 rounded-full text-xs text-blue-700">{l.name}</span>
                      ))}
                    </div>
                  </div>
                )}
                {data.siteIntelligence.branding?.colors && data.siteIntelligence.branding.colors.length > 0 && (
                  <div>
                    <span className="text-xs font-semibold text-[#6B6B6B] uppercase">Brand Colors</span>
                    <div className="flex gap-2 mt-1">
                      {data.siteIntelligence.branding.colors.slice(0, 5).map((c, i) => (
                        <div key={i} className="w-6 h-6 rounded border border-[#E6E8EA]" style={{ backgroundColor: c }} title={c} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>
        )}

        {/* SOP Routing Section */}
        <section className="bg-white rounded-xl border border-[#E6E8EA] p-6">
          <h2 className="text-lg font-bold text-[#0B0B0B] mb-4">SOP Routing — Pre-Contract Big 5</h2>
          {data.sopRouting ? (
            <div className="space-y-4">
              {/* Big 5 Summary */}
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                {[
                  { key: 'own_domain', label: 'Own Domain?' },
                  { key: 'control_dns', label: 'Control DNS?' },
                  { key: 'is_wordpress', label: 'WordPress?' },
                  { key: 'own_written_content', label: 'Own Content?' },
                  { key: 'own_license_images', label: 'Own Images?' },
                ].map(({ key, label }) => {
                  const val = data.sopRouting!.big5[key];
                  const isNo = val === 'no';
                  return (
                    <div
                      key={key}
                      className={`p-3 rounded-lg border ${isNo ? 'border-[#E5484D]/30 bg-red-50' : val === 'yes' ? 'border-[#25DC7F]/30 bg-[#25DC7F]/5' : 'border-[#E6E8EA] bg-[#F4F5F6]'}`}
                    >
                      <div className="text-xs font-semibold text-[#6B6B6B]">{label}</div>
                      <div className={`text-sm font-bold ${isNo ? 'text-[#E5484D]' : val === 'yes' ? 'text-[#25DC7F]' : 'text-[#6B6B6B]'}`}>
                        {val === 'yes' ? 'Yes' : val === 'no' ? 'No' : val === 'not_sure' ? 'Not Sure' : 'Not Answered'}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Required SOPs */}
              {data.sopRouting.required_sops.length > 0 ? (
                <div>
                  <h3 className="text-sm font-semibold text-[#0B0B0B] mb-2">Required SOPs</h3>
                  <div className="space-y-2">
                    {data.sopRouting.required_sops.map((sop, i) => (
                      <div key={i} className="flex items-center gap-2 p-2 bg-[#FEF3C7] border border-[#F5A524]/30 rounded-lg">
                        <svg className="w-4 h-4 text-[#F5A524]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <span className="text-sm font-medium text-[#92400E]">{sop}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="p-3 bg-[#ECFDF5] border border-[#25DC7F]/30 rounded-lg text-sm text-[#065F46] font-medium">
                  No additional SOPs required — standard onboarding.
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-[#6B6B6B]">SOP routing not yet computed for this session.</p>
          )}
        </section>

        {/* Work Order Section */}
        <section className="bg-white rounded-xl border border-[#E6E8EA] p-6">
          <h2 className="text-lg font-bold text-[#0B0B0B] mb-4">Internal Work Order</h2>
          {data.workOrder ? (
            <div className="space-y-4">
              <p className="text-xs text-[#6B6B6B]">
                Generated: {new Date(data.workOrder.generated_at).toLocaleString()}
              </p>

              {/* Onboarding Tasks */}
              <div>
                <h3 className="text-sm font-semibold text-[#0B0B0B] mb-2">Onboarding Dev Tasks</h3>
                <div className="border border-[#E6E8EA] rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-[#F4F5F6]">
                      <tr>
                        <th className="text-left px-4 py-2 font-semibold text-[#6B6B6B]">Task</th>
                        <th className="text-left px-4 py-2 font-semibold text-[#6B6B6B]">Owner</th>
                        <th className="text-left px-4 py-2 font-semibold text-[#6B6B6B]">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {onboardingTasks.map((task, i) => (
                        <tr key={i} className="border-t border-[#E6E8EA]">
                          <td className="px-4 py-2 font-medium text-[#0B0B0B]">{task.title}</td>
                          <td className="px-4 py-2 text-[#6B6B6B]">{task.owner}</td>
                          <td className="px-4 py-2">
                            <span className="px-2 py-0.5 bg-[#F4F5F6] rounded text-xs font-medium text-[#6B6B6B] capitalize">
                              {task.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* SOP Tasks */}
              {sopTasks.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-[#0B0B0B] mb-2">SOP-Triggered Tasks</h3>
                  <div className="border border-[#E6E8EA] rounded-lg overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-[#FEF3C7]">
                        <tr>
                          <th className="text-left px-4 py-2 font-semibold text-[#92400E]">SOP</th>
                          <th className="text-left px-4 py-2 font-semibold text-[#92400E]">Owner</th>
                          <th className="text-left px-4 py-2 font-semibold text-[#92400E]">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sopTasks.map((task, i) => (
                          <tr key={i} className="border-t border-[#F5A524]/20">
                            <td className="px-4 py-2 font-medium text-[#0B0B0B]">{task.title}</td>
                            <td className="px-4 py-2 text-[#6B6B6B]">{task.owner}</td>
                            <td className="px-4 py-2">
                              <span className="px-2 py-0.5 bg-[#FEF3C7] rounded text-xs font-medium text-[#92400E] capitalize">
                                {task.status}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-[#6B6B6B]">Work order not yet generated. It will be created when the client submits.</p>
          )}
        </section>

        {/* Confirmed Answers Summary */}
        <section className="bg-white rounded-xl border border-[#E6E8EA] p-6 print:break-before-page">
          <h2 className="text-lg font-bold text-[#0B0B0B] mb-4">Confirmed Onboarding Answers</h2>
          <div className="space-y-4">
            {Object.entries(data.answers).map(([stepKey, stepData]) => {
              const entries = Object.entries(stepData.answers || {}).filter(([, v]) => v !== null && v !== undefined && v !== '');
              if (entries.length === 0) return null;
              return (
                <div key={stepKey}>
                  <h3 className="text-sm font-semibold text-[#6B6B6B] uppercase mb-2">
                    {stepKey.replace(/_/g, ' ')}
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {entries.map(([key, value]) => (
                      <div key={key} className="p-2 bg-[#F4F5F6] rounded">
                        <div className="text-xs text-[#6B6B6B]">{key.replace(/_/g, ' ')}</div>
                        <div className="text-sm text-[#0B0B0B]">
                          {Array.isArray(value) ? value.join(', ') : String(value)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </main>

      {/* Print-only footer */}
      <div className="hidden print:block text-center text-xs text-[#A0A0A0] py-4">
        Onboarding Final Report (Sunset) &mdash; Generated by Clixsy Onboarding Portal
      </div>
    </div>
  );
}
