import { Module } from '@nestjs/common';
import { ApprovalsController, WorkflowDefinitionsController } from './workflow.controller';
import { WorkflowEngineService } from './workflow-engine.service';

@Module({
  controllers: [WorkflowDefinitionsController, ApprovalsController],
  providers: [WorkflowEngineService],
  exports: [WorkflowEngineService],
})
export class WorkflowModule {}
