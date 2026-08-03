import { IsIn, IsNotEmpty, IsObject, IsOptional, IsString, IsUUID } from 'class-validator';
import { WorkflowGraph } from '../workflow-graph.types';

export class CreateWorkflowDefinitionDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsObject()
  graph!: WorkflowGraph;
}

/**
 * Note what is **not** here: `approverId`.
 *
 * It used to be a client-supplied field, which meant the "is this the assigned approver?"
 * check compared a value the caller chose against a value the caller could look up — it
 * stopped mistakes, not people. The actor now comes from the session and the DTO cannot
 * express an actor at all, so there is no field to forge. `forbidNonWhitelisted` on the
 * global ValidationPipe means a request still sending one is rejected outright rather than
 * having it silently ignored.
 */
export class DecideStepDto {
  @IsIn(['APPROVE', 'REJECT'])
  decision!: 'APPROVE' | 'REJECT';

  @IsOptional()
  @IsString()
  comment?: string;
}

export class DelegateStepDto {
  /**
   * Only the *recipient*. Who is delegating is the session — a handoff you can perform on
   * someone else's behalf is not a handoff.
   */
  @IsUUID()
  toApproverId!: string;

  @IsOptional()
  @IsString()
  comment?: string;
}

/**
 * What the **engine** is called with, as opposed to what arrives over HTTP.
 *
 * Deliberately separate types. The DTO describes a request body and cannot name an actor;
 * this describes an operation and must. Keeping them apart is what makes it impossible to
 * accidentally widen the DTO back into an actor field — the controller has to reach for the
 * session to satisfy the engine's signature.
 */
export type DecideStepInput = DecideStepDto & { approverId: string };
export type DelegateStepInput = DelegateStepDto & { fromApproverId: string };
