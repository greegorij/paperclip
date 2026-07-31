import { useQuery } from "@tanstack/react-query";
import { fleetModelPolicyApi } from "@/api/fleet-model-policy";
import { queryKeys } from "@/lib/queryKeys";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function FleetModelPolicyCard({
  companyId,
  isProviderTabActive,
}: {
  companyId?: string | null;
  isProviderTabActive: boolean;
}) {
  const isEnabled = Boolean(companyId) && isProviderTabActive;
  const modelPolicy = useQuery({
    queryKey: queryKeys.fleetModelPolicy(companyId ?? "__none__"),
    queryFn: () => fleetModelPolicyApi.get(companyId as string),
    enabled: isEnabled,
  });

  if (!isEnabled) return null;

  if (modelPolicy.isLoading) {
    return (
      <Card>
        <CardContent className="px-5 py-5 text-sm text-muted-foreground">
          Loading model policy preview…
        </CardContent>
      </Card>
    );
  }

  if (modelPolicy.isError || !modelPolicy.data) {
    return (
      <Card>
        <CardHeader className="px-5 pt-5 pb-2">
          <CardTitle className="text-base">Model policy</CardTitle>
        </CardHeader>
        <CardContent className="px-5 pb-5 pt-2 text-sm text-muted-foreground">
          Unable to load the model policy preview. Try again later.
        </CardContent>
      </Card>
    );
  }

  const policy = modelPolicy.data;
  const profiles = Object.entries(policy.profiles).sort(([left], [right]) => left.localeCompare(right));
  const roles = Object.entries(policy.roles).sort(([left], [right]) => left.localeCompare(right));

  return (
    <Card>
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="text-base">Model policy</CardTitle>
        <CardDescription>
          Read-only preview. This profile is not activated or applied.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 px-5 pb-5 pt-2">
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted-foreground">Policy ID</dt>
            <dd className="mt-1 font-mono text-xs">{policy.policyId}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Version</dt>
            <dd className="mt-1 font-mono text-xs">{policy.version}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Mode</dt>
            <dd className="mt-1 text-sm font-medium">{policy.mode}</dd>
          </div>
        </dl>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold">Profiles</h2>
          <div className="grid gap-3 xl:grid-cols-2">
            {profiles.map(([profileId, profile]) => (
              <div key={profileId} className="border border-border p-3">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="text-sm font-medium">{profileId}</h3>
                  <span className="font-mono text-xs text-muted-foreground">{profile.version}</span>
                </div>
                <ul className="mt-3 space-y-2">
                  {profile.agents.map((agent) => (
                    <li key={agent.slug} className="grid gap-1 text-xs sm:grid-cols-3">
                      <span className="font-mono text-muted-foreground">{agent.slug}</span>
                      <span className="font-mono">{agent.model}</span>
                      <span className="text-muted-foreground">{agent.modelReasoningEffort ?? "Unspecified"}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold">Role model routing</h2>
          <div className="grid gap-3 xl:grid-cols-2">
            {roles.map(([roleId, role]) => (
              <div key={roleId} className="border border-border p-3">
                <h3 className="font-mono text-xs text-muted-foreground">{roleId}</h3>
                <dl className="mt-3 grid gap-2 text-xs">
                  <div className="grid gap-1 sm:grid-cols-3">
                    <dt className="text-muted-foreground">Primary</dt>
                    <dd className="font-mono">{role.primary.model}</dd>
                  </div>
                  <div className="grid gap-1 sm:grid-cols-3">
                    <dt className="text-muted-foreground">Fallback</dt>
                    <dd className="font-mono">
                      {role.fallback.map((fallback) => fallback.model).join(", ") || "None"}
                    </dd>
                  </div>
                </dl>
              </div>
            ))}
          </div>
        </section>
      </CardContent>
    </Card>
  );
}
