import type { EntitlementTier } from "../domain/products.js";

export type Role = {
  id: string;
  name: string;
  position: number;
  permissions: string;
  managed: boolean;
};
export type Member = {
  id: string;
  roles: string[];
  pending?: boolean;
  bot?: boolean;
};
export type GuildState = {
  id: string;
  ownerId: string;
  bot: Member;
  roles: Role[];
};
export interface DiscordAdapter {
  readonly kind: "mock" | "rest" | "dry-run";
  inspectGuild(): Promise<GuildState>;
  getMember(id: string): Promise<Member | null>;
  listMembers(after: string, limit: number): Promise<Member[]>;
  addRole(memberId: string, roleId: string): Promise<void>;
  removeRole(memberId: string, roleId: string): Promise<void>;
}
export class DiscordFailure extends Error {
  public constructor(
    public readonly code: string,
    public readonly retryable = false,
    public readonly retryAfterMs = 0,
  ) {
    super(code);
  }
}
export type Preview = {
  userId: string;
  discordUserId: string;
  guildId: string;
  currentRoles: string[];
  effectiveMembership: EntitlementTier;
  desiredRoles: string[];
  add: string[];
  remove: string[];
  ownershipConflicts: string[];
  reason: string;
  entitlementReferences: string[];
  timestamp: string;
  permitted: boolean;
  dryRun: true;
  simulated: boolean;
  errorCode: string | null;
};
