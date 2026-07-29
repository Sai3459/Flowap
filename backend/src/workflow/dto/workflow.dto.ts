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

  @IsUUID()
  approverId!: string;

  @IsOptional()
  @IsString()
  comment?: string;
}
