import type * as React from 'react';
export type Priority = 'emergency' | 'high' | 'normal' | 'low';
export type Category = 'plumbing' | 'electrical' | 'heating' | 'appliance' | 'structural' | 'pest' | 'other';
export type TicketStatusValue = 'open' | 'in_progress' | 'resolved' | 'cancelled';
export type Outcome = 'ok' | 'rejected' | 'error' | 'completed' | 'failed';
export type Stage = 'validate' | 'authorize' | 'policy' | 'idempotency' | 'execute';
export interface Ticket { id: string; priority: Priority; category: Category; status: TicketStatusValue; date: string; title: string; description?: string; review?: boolean; reviewReason?: string }
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> { variant?: 'primary' | 'secondary' | 'ghost'; size?: 'md' | 'sm'; icon?: string; pending?: boolean; pendingLabel?: string }
export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> { label: string; hideLabel?: boolean; options: (string | { value: string; label: string })[]; hint?: string; error?: string; pending?: boolean }
export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> { label: string; hideLabel?: boolean; hint?: string; error?: string; pending?: boolean }
export interface PriorityBadgeProps { priority: Priority }
export interface OutcomeBadgeProps { status: Outcome; label?: string }
export interface ReviewBadgeProps { children?: React.ReactNode }
export interface TicketStatusProps { status: TicketStatusValue }
export interface ChatBubbleProps { role?: 'tenant' | 'assistant'; state?: 'sent' | 'pending' | 'failed'; time?: string; after?: React.ReactNode; children?: React.ReactNode }
export interface ChatLogProps { children?: React.ReactNode; empty?: React.ReactNode }
export interface EmergencyNoticeProps { title: string; children?: React.ReactNode }
export interface ComposerProps { onSend?: (text: string) => void; pending?: boolean; disabled?: boolean; error?: string; placeholder?: string; value?: string; onChange?: (v: string) => void }
export interface TicketCardProps { ticket: Ticket }
export interface TicketListProps { tickets: Ticket[] }
export interface TenantSwitcherProps { tenants: { id: string; name: string }[]; value?: string; onSwitch?: (id: string) => void }
export interface PipelineStagesProps { status: 'ok' | 'rejected' | 'error'; stoppedAt?: Stage }
export interface JsonBlockProps { value: unknown; label?: string }
export interface TimelineEventProps { event: { step: number; kind: 'model' | 'tool'; ms: number; tokens?: number; model?: string; requested?: string[]; tool?: string; status?: 'ok' | 'rejected' | 'error'; stoppedAt?: Stage; reason?: string; args?: unknown; result?: unknown; ticket?: { id: string; priority: Priority; policy: string } }; defaultOpen?: boolean }
export interface RunsTableProps { runs: { id: string; time: string; workflow: string; tenant: string; agency: string; status: 'completed' | 'failed'; steps: number; ms: number; tokens: number; cost: number; source: 'portal' | 'eval' }[]; selectedId?: string }
export interface PassRateProps { passed: number; total: number; infra?: number }
export interface IconProps { name: 'alert' | 'alertFill' | 'shield' | 'person' | 'check' | 'x' | 'clock' | 'tool' | 'cpu' | 'chevron' | 'send' | 'home'; size?: 'md' | 'sm' }
