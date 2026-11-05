// Filas que llegan por IPC (main/rows.js). Solo valores validados y recuentos, nunca contenido.
export type State = 'WORKING' | 'PERMISSION' | 'IDLE' | 'ERROR' | 'ENDED' | 'STALE';
type Common = { session_id: string; state: State; since: number | null; first: number | null; tool: string | null; tools: number; events: number };
export type Session = Common & { kind: 'session'; project_id: string | null };
export type Agent = Common & { kind: 'agent'; agent_id: string; agent_types: string[]; evidence: 'INFERRED' | 'UNKNOWN'; parent: string | null };
export type Row = Session | Agent;
export type Delta = { upsert: [string, Row][]; remove: string[] };
export type Project = { project_id: string; name: string | null; status: 'enabled' | 'excluded' | 'pending' };
