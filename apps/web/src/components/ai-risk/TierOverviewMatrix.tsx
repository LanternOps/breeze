import { formatToolName } from '../../lib/utils';
import { TIER_DEFINITIONS } from './tierConfig';

export function TierOverviewMatrix() {
  return (
    <div>
      <h2 className="mb-4 text-lg font-semibold">Guardrail Tier Matrix</h2>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {TIER_DEFINITIONS.map((tier) => {
          const Icon = tier.icon;
          return (
            <div
              key={tier.tier}
              className={`rounded-lg border border-l-4 bg-card p-5 shadow-sm ${tier.borderColor}`}
            >
              <div className="flex items-center justify-between">
                <span
                  className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${tier.badgeBg} ${tier.badgeText}`}
                >
                  Tier {tier.tier}
                </span>
                <Icon className="h-5 w-5 text-muted-foreground" />
              </div>

              <h3 className="mt-3 text-sm font-semibold">{tier.label}</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {tier.description}
              </p>

              <div className="mt-4 space-y-1.5">
                {tier.tools.map((tool) => (
                  <div key={tool.name} className="flex gap-2 text-xs leading-5">
                    <span className="mt-[7px] h-1.5 w-1.5 flex-shrink-0 rounded-full bg-muted-foreground/40" />
                    <p>
                      <span className="font-medium">
                        {formatToolName(tool.name)}
                      </span>
                      <span className="ml-1 text-muted-foreground">
                        — {tool.description}
                      </span>
                    </p>
                  </div>
                ))}
              </div>

              <div className="mt-4 border-t pt-3">
                <span className="text-xs text-muted-foreground">
                  {tier.tools.length} tool{tier.tools.length !== 1 ? 's' : ''}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

