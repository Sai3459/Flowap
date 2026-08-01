import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { WorkflowEngineService } from './workflow-engine.service';
import { CreateWorkflowDefinitionDto, DecideStepDto, DelegateStepDto } from './dto/workflow.dto';

@ApiTags('workflow-definitions')
@ApiHeader({ name: 'x-tenant-id', required: true })
@Controller('workflow-definitions')
export class WorkflowDefinitionsController {
  constructor(private readonly workflowEngine: WorkflowEngineService) {}

  @Post()
  create(@Headers('x-tenant-id') tenantId: string, @Body() dto: CreateWorkflowDefinitionDto) {
    return this.workflowEngine.createDefinition(tenantId, dto);
  }

  @Get()
  list(@Headers('x-tenant-id') tenantId: string) {
    return this.workflowEngine.listDefinitions(tenantId);
  }

  @Get(':id')
  getOne(@Headers('x-tenant-id') tenantId: string, @Param('id') id: string) {
    return this.workflowEngine.getDefinition(tenantId, id);
  }

  /**
   * Puts a draft into service and retires the previous published version, in one transaction.
   * There is deliberately no PATCH: a published definition is immutable, so changing a
   * workflow means creating a new draft and publishing that. This is what lets an in-flight
   * instance keep running the graph it started under.
   */
  @Post(':id/publish')
  publish(@Headers('x-tenant-id') tenantId: string, @Param('id') id: string) {
    return this.workflowEngine.publishDefinition(tenantId, id);
  }

  /** Takes a definition out of service without replacing it — new invoices go unrouted. */
  @Post(':id/retire')
  retire(@Headers('x-tenant-id') tenantId: string, @Param('id') id: string) {
    return this.workflowEngine.retireDefinition(tenantId, id);
  }
}

@ApiTags('approvals')
@ApiHeader({ name: 'x-tenant-id', required: true })
@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly workflowEngine: WorkflowEngineService) {}

  // Declared before ':invoiceId' so the literal path isn't swallowed by the param route.
  @Get('overdue')
  overdue(@Headers('x-tenant-id') tenantId: string) {
    return this.workflowEngine.findOverdueSteps(tenantId);
  }

  /** One approver's work queue — what is waiting on them right now. */
  @Get('inbox/:approverId')
  inbox(@Headers('x-tenant-id') tenantId: string, @Param('approverId') approverId: string) {
    return this.workflowEngine.findPendingForApprover(tenantId, approverId);
  }

  /** One approver's decision history — what they have already approved, rejected or delegated. */
  @Get('history/:approverId')
  history(@Headers('x-tenant-id') tenantId: string, @Param('approverId') approverId: string) {
    return this.workflowEngine.findHistoryForApprover(tenantId, approverId);
  }

  /** How many approvals an invoice has had and how many it still needs. */
  @Get(':invoiceId/progress')
  progress(@Headers('x-tenant-id') tenantId: string, @Param('invoiceId') invoiceId: string) {
    return this.workflowEngine.getApprovalProgress(tenantId, invoiceId);
  }

  @Post('escalate-overdue')
  escalateOverdue(@Headers('x-tenant-id') tenantId: string) {
    return this.workflowEngine.escalateOverdueSteps(tenantId);
  }

  @Get(':invoiceId')
  getInstance(@Headers('x-tenant-id') tenantId: string, @Param('invoiceId') invoiceId: string) {
    return this.workflowEngine.getInstance(tenantId, invoiceId);
  }

  @Post('steps/:stepId/decide')
  decideStep(
    @Headers('x-tenant-id') tenantId: string,
    @Param('stepId') stepId: string,
    @Body() dto: DecideStepDto,
  ) {
    return this.workflowEngine.decideStep(tenantId, stepId, dto);
  }

  @Post('steps/:stepId/delegate')
  delegateStep(
    @Headers('x-tenant-id') tenantId: string,
    @Param('stepId') stepId: string,
    @Body() dto: DelegateStepDto,
  ) {
    return this.workflowEngine.delegateStep(tenantId, stepId, dto);
  }
}
