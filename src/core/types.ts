// Core domain model for Brain Dump.
// Everything the assistant knows about a user lives in a single UserState document
// so it can be synchronised across devices and persisted atomically.

export type ID = string;
export type ISODate = string;

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export interface Preferences {
  /** What "clear" means for email: reversible archive (default) or deletion. */
  clearMeans: 'archive' | 'delete';
  /** Spoken replies in voice sessions. */
  voiceReplies: boolean;
  weeklyBriefing: { enabled: boolean; weekday: number; hour: number };
  /** quiet = only essential notifications; normal = also useful suggestions. */
  proactivity: 'quiet' | 'normal';
  /** Minutes before an event to remind, unless a routine says otherwise. */
  defaultEventLeadMin: number;
  /** Purchases at or above this amount always need explicit confirmation. Purchases always do; this is informational. */
  purchaseConfirmThreshold: number;
  /** A personal meeting link (e.g. a Zoom personal room) to use when no meeting provider is connected. */
  personalMeetingLink?: { provider: 'zoom' | 'meet' | 'teams' | 'other'; url: string };
  /** Combine separately captured groceries into one list sent before the user usually shops. */
  shoppingDigest?: { weekday?: number; hour: number };
}

export interface Profile {
  userId: ID;
  displayName?: string;
  /** The name the user chose for their assistant ("Milo"). */
  assistantName?: string;
  /** Known speech-to-text mishearings of the assistant name. */
  nameAliases: string[];
  /** IANA timezone, e.g. "Europe/London". */
  timeZone: string;
  onboarding: 'name' | 'permissions' | 'done';
  createdAt: ISODate;
  preferences: Preferences;
}

// ---------------------------------------------------------------------------
// Everyday state
// ---------------------------------------------------------------------------

export interface CalendarEvent {
  id: ID;
  title: string;
  /** UTC instant. */
  start: ISODate;
  end: ISODate;
  /** IANA zone the event was stated in. */
  timeZone: string;
  /** The original wording, e.g. "2 PM Rick's time". */
  statedAs?: string;
  allDay?: boolean;
  location?: string;
  attendees: ID[];
  notes?: string;
  status: 'confirmed' | 'cancelled';
  meeting?: { provider: string; url: string };
  source: string;
  externalId?: string;
  routineId?: ID;
  /** Minutes before start to remind the user (overrides the default). */
  leadMin?: number;
  remindedAt?: ISODate;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export type ReminderKind = 'task' | 'call' | 'message' | 'follow_up' | 'booking' | 'timer' | 'alarm';

export interface Reminder {
  id: ID;
  text: string;
  dueAt?: ISODate;
  status: 'open' | 'done' | 'archived';
  kind: ReminderKind;
  personId?: ID;
  createdAt: ISODate;
  updatedAt: ISODate;
  completedAt?: ISODate;
  notifiedAt?: ISODate;
}

export interface ShoppingItem {
  id: ID;
  name: string;
  quantity?: number;
  status: 'needed' | 'got' | 'removed';
  addedAt: ISODate;
  updatedAt: ISODate;
}

export interface Note {
  id: ID;
  text: string;
  kind: 'note' | 'idea';
  createdAt: ISODate;
}

/** message = unspecified (offer WhatsApp and Messages), sms = iMessage/text. */
export type Channel = 'email' | 'message' | 'whatsapp' | 'sms';

export interface Draft {
  id: ID;
  channel: Channel;
  to: ID;
  subject?: string;
  body: string;
  status: 'draft' | 'sent' | 'handed_off' | 'discarded';
  createdAt: ISODate;
  updatedAt: ISODate;
  sentAt?: ISODate;
  /** A deep link that opens the user's own app with the message ready (wa.me, mailto:, sms:). */
  handoffUrl?: string;
  relatedEventId?: ID;
  reminderId?: ID;
}

export interface WaitingItem {
  id: ID;
  /** 'them' = waiting for someone else; 'me' = someone is waiting for the user. */
  direction: 'them' | 'me';
  personId?: ID;
  who: string;
  about: string;
  since: ISODate;
  status: 'waiting' | 'resolved';
  resolvedAt?: ISODate;
  relatedId?: ID;
  notifyOnReply: boolean;
  nudgedAt?: ISODate;
}

export interface Contact {
  id: ID;
  name: string;
  aliases: string[];
  email?: string;
  phone?: string;
  timeZone?: string;
  city?: string;
  relationship?: string;
  source: 'told' | 'provider' | 'inferred';
  createdAt: ISODate;
}

// ---------------------------------------------------------------------------
// Memory & behaviour
// ---------------------------------------------------------------------------

export type Provenance = 'told' | 'observed' | 'inferred' | 'suggested' | 'confirmed';

export interface Memory {
  id: ID;
  kind: 'person' | 'place' | 'preference' | 'routine' | 'service' | 'fact' | 'identity';
  subject: string;
  value: string;
  provenance: Provenance;
  source: string;
  confidence: number;
  learnedAt: ISODate;
  observationCount: number;
  lastObservedAt: ISODate;
  confirmed: boolean;
  automationAllowed: boolean;
}

export interface RoutineSetup {
  playlist?: { provider: string; name: string; url?: string };
  fitness?: { provider: string; activity: string; url?: string };
  leadMin?: number;
}

export interface Routine {
  id: ID;
  title: string;
  kind: 'exercise' | 'run' | 'appointment' | 'shopping' | 'other';
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  hour: number;
  minute: number;
  durationMin: number;
  /** confirmed = remembered; automated = user allowed the assistant to handle instances itself. */
  status: 'confirmed' | 'automated' | 'paused';
  setup?: RoutineSetup;
  memoryId?: ID;
  /** Shopping routines: the staple items. */
  items?: string[];
  createdAt: ISODate;
  /** Occurrence keys (YYYY-MM-DD) already handled, to keep automation idempotent. */
  handled: string[];
}

export interface Observation {
  id: ID;
  at: ISODate;
  kind:
    | 'event_created'
    | 'item_added'
    | 'reminder_created'
    | 'manual_check'
    | 'booking'
    | 'lead_time'
    | 'separate_capture'
    | 'activity';
  key: string;
  meta?: Record<string, unknown>;
}

export interface Suggestion {
  id: ID;
  kind: 'routine' | 'staples' | 'notify_reply' | 'remember_provider' | 'lead_time' | 'combine_capture' | 'prepare_routine' | 'nudge';
  key: string;
  text: string;
  status: 'pending' | 'offered' | 'accepted' | 'declined' | 'expired';
  score: number;
  createdAt: ISODate;
  offeredAt?: ISODate;
  respondedAt?: ISODate;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Permissions, trust & ledger
// ---------------------------------------------------------------------------

export type Scope =
  | 'calendar'
  | 'reminders'
  | 'shopping'
  | 'notes'
  | 'memory'
  | 'email'
  | 'messaging'
  | 'contacts'
  | 'meetings'
  | 'bookings'
  | 'purchases'
  | 'music'
  | 'fitness';

/** read < draft < act. "act" = manage/send/perform on the user's behalf within scope. */
export type PermissionLevel = 'none' | 'read' | 'draft' | 'act';

export interface Permission {
  scope: Scope;
  level: PermissionLevel;
  grantedAt?: ISODate;
  /** Free-text record of how it was granted, for auditability. */
  grantedVia?: string;
}

export interface TrustRecord {
  actionType: string;
  confirmed: number;
  rejected: number;
  /** Explicitly trusted by the user ("you don't need to ask me about that"), or earned through confirmations. */
  trusted: boolean;
  trustedVia?: 'explicit' | 'earned';
  updatedAt: ISODate;
}

export type EntityKind = 'event' | 'reminder' | 'shopping' | 'note' | 'draft' | 'waiting' | 'memory' | 'contact' | 'routine' | 'email';

export interface LedgerEntry {
  id: ID;
  at: ISODate;
  sessionId?: ID;
  /** Entries created by one user request share a batch, so "undo" reverses the whole thing. */
  batchId?: ID;
  actionType: string;
  summary: string;
  entity: EntityKind;
  entityId: ID;
  /** Only verified actions may be reported as handled. */
  verified: boolean;
  /** Whether the assistant acted without asking (trusted/low-risk). */
  auto: boolean;
  risk: RiskLevel;
  before: unknown | null;
  after: unknown | null;
  undoable: boolean;
  undoneAt?: ISODate;
}

export type RiskLevel = 'low' | 'medium' | 'high';

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

export type Ref = { kind: EntityKind; id: ID };

export interface Turn {
  at: ISODate;
  role: 'user' | 'assistant';
  text: string;
}

export interface QuestionOption {
  label: string;
  value: string;
}

/** A question the assistant asked and is waiting on. Fully serialisable. */
export interface PendingQuestion {
  id: ID;
  kind:
    | 'clarify_target'
    | 'confirm_action'
    | 'grant_permission'
    | 'offer_reschedule'
    | 'fill_slot'
    | 'suggestion'
    | 'briefing'
    | 'onboarding';
  text: string;
  options?: QuestionOption[];
  askedAt: ISODate;
  /** Optional questions can be silently dropped at session end. */
  optional: boolean;
  /** Whether it has been voiced to the user yet. */
  asked: boolean;
  data: Record<string, any>;
}

export interface Session {
  id: ID;
  startedAt: ISODate;
  lastActivityAt: ISODate;
  endedAt?: ISODate;
  device?: string;
  turns: Turn[];
  /** Most recent first. */
  focus: Ref[];
  lastPersonId?: ID;
  pending: PendingQuestion[];
  ledgerIds: ID[];
}

export interface AppNotification {
  id: ID;
  at: ISODate;
  kind: 'reminder' | 'event' | 'suggestion' | 'briefing' | 'waiting' | 'system';
  text: string;
  key: string;
  read: boolean;
  actions?: QuestionOption[];
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Email (provider-backed)
// ---------------------------------------------------------------------------

export interface EmailMessage {
  id: ID;
  from: string;
  fromName?: string;
  to: string[];
  subject: string;
  snippet: string;
  receivedAt: ISODate;
  labels: string[];
  unread: boolean;
  threadId?: string;
}

// ---------------------------------------------------------------------------
// The whole document
// ---------------------------------------------------------------------------

export interface UserState {
  schemaVersion: number;
  version: number;
  profile: Profile;
  events: CalendarEvent[];
  reminders: Reminder[];
  shopping: ShoppingItem[];
  notes: Note[];
  drafts: Draft[];
  waiting: WaitingItem[];
  contacts: Contact[];
  memories: Memory[];
  routines: Routine[];
  observations: Observation[];
  suggestions: Suggestion[];
  permissions: Permission[];
  trust: TrustRecord[];
  ledger: LedgerEntry[];
  sessions: Session[];
  notifications: AppNotification[];
  /** Local mailbox used when no email provider is connected (and by tests). */
  mailbox: EmailMessage[];
  /** clientId → reply, so offline captures replayed twice never duplicate. */
  processed: { clientId: string; at: ISODate; reply: unknown }[];
  /** Connected external services (tokens live in the encrypted store, never in plain logs). */
  integrations: Record<string, { connectedAt: ISODate; scopes: string[]; account?: string; data?: Record<string, unknown> }>;
}
