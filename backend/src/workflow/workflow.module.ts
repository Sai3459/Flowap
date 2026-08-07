import { Module } from '@nestjs/common';
import { ApprovalsController, WorkflowDefinitionsController } from './workflow.controller';
import { AutoApproveService } from './auto-approve.service';
import { WorkflowEngineService } from './workflow-engine.service';
import { SlaSchedulerService } from './sla-scheduler.service';

@Module({
  controllers: [WorkflowDefinitionsController, ApprovalsController],
  providers: [AutoApproveService, WorkflowEngineService, SlaSchedulerService],
  exports: [AutoApproveService, WorkflowEngineService],
})
export class WorkflowModule {}
