import { Module } from '@nestjs/common';
import { ApprovalsController, WorkflowDefinitionsController } from './workflow.controller';
import { WorkflowEngineService } from './workflow-engine.service';
import { SlaSchedulerService } from './sla-scheduler.service';

@Module({
  controllers: [WorkflowDefinitionsController, ApprovalsController],
  providers: [WorkflowEngineService, SlaSchedulerService],
  exports: [WorkflowEngineService],
})
export class WorkflowModule {}
