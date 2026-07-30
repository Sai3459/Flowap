import { IsIn, IsNotEmpty, IsObject, IsOptional, IsString, IsUUID } from 'class-validator';
import { WorkflowGraph } from '../workflow-graph.types';

export class CreateWorkflowDefinitionDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsObject()
  graph!: WorkflowGraph;
}

export class DecideStepDto {
  @IsIn(['APPROVE', 'REJECT'])
  decision!: 'APPROVE' | 'REJECT';

  // Must match the step's assigned approver. Client-supplied for now, same as the
  // x-tenant-id header — becomes the SSO session subject once real auth lands.
  @IsUUID()
  approverId!: string;

  @IsOptional()
  @IsString()
  comment?: string;
}

export class DelegateStepDto {
  /** The step's current assigned approver, handing the decision off. */
  @IsUUID()
  fromApproverId!: string;

  @IsUUID()
  toApproverId!: string;

  @IsOptional()
  @IsString()
  comment?: string;
}
