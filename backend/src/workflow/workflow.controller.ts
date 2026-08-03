import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { WorkflowEngineService } from './workflow-engine.service';
import { CreateWorkflowDefinitionDto, DecideStepDto, DelegateStepDto } from './dto/workflow.dto';
import { CurrentUser } from '../auth/current-user.decorator';
import type { Principal } from '../auth/principal';
import { Roles } from '../auth/roles.decorator';

@ApiTags('workflow-definitions')
@ApiBearerAuth()
@Controller('workflow-definitions')
export class WorkflowDefinitionsController {
  constructor(private readonly workflowEngine: WorkflowEngineService) {}

  @Roles('ADMIN')
  @Post()
  create(@CurrentUser() { tenantId }: Principal, @Body() dto: CreateWorkflowDefinitionDto) {
    return this.workflowEngine.createDefinition(tenantId, dto);
  }

  @Get()
  list(@CurrentUser() { tenantId }: Principal) {
    return this.workflowEngine.listDefinitions(tenantId);
  }

  @Get(':id')
  getOne(@CurrentUser() { tenantId }: Principal, @Param('id') id: string) {
    return this.workflowEngine.getDefinition(tenantId, id);
  }

  /**
   * Puts a draft into service and retires the previous published version, in one transaction.
   * There is deliberately no PATCH: a published definition is immutable, so changing a
   * workflow means creating a new draft and publishing that. This is what lets an in-flight
   * instance keep running the graph it started under.
   */
  @Roles('ADMIN')
  @Post(':id/publish')
  publish(@CurrentUser() { tenantId }: Principal, @Param('id') id: string) {
    return this.workflowEngine.publishDefinition(tenantId, id);
  }

  /** Takes a definition out of service without replacing it — new invoices go unrouted. */
  @Roles('ADMIN')
  @Post(':id/retire')
  retire(@CurrentUser() { tenantId }: Principal, @Param('id') id: string) {
    return this.workflowEngine.retireDefinition(tenantId, id);
  }
}

@ApiTags('approvals')
@ApiBearerAuth()
@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly workflowEngine: WorkflowEngineService) {}

  // Declared before ':invoiceId' so the literal path isn't swallowed by the param route.
  @Roles('AP_CLERK', 'AP_MANAGER', 'CONTROLLER', 'ADMIN')
  @Get('overdue')
  overdue(@CurrentUser() { tenantId }: Principal) {
    return this.workflowEngine.findOverdueSteps(tenantId);
  }

  /**
   * The caller's own work queue.
   *
   * The approver id used to be a path parameter, which meant any authenticated user could
   * read any colleague's queue by changing it — a plain IDOR, and one that leaks which
   * invoices are in flight and who is sitting on them. It is the session now, so the route
   * takes no id and there is nothing to enumerate.
   */
  @Get('inbox')
  inbox(@CurrentUser() { tenantId, userId }: Principal) {
    return this.workflowEngine.findPendingForApprover(tenantId, userId);
  }

  /** The caller's own decision history. Session-scoped for the same reason as the inbox. */
  @Get('history')
  history(@CurrentUser() { tenantId, userId }: Principal) {
    return this.workflowEngine.findHistoryForApprover(tenantId, userId);
  }

  /** How many approvals an invoice has had and how many it still needs. */
  @Roles('AP_CLERK', 'APPROVER', 'AP_MANAGER', 'CONTROLLER', 'ADMIN')
  @Get(':invoiceId/progress')
  progress(@CurrentUser() { tenantId }: Principal, @Param('invoiceId') invoiceId: string) {
    return this.workflowEngine.getApprovalProgress(tenantId, invoiceId);
  }

  @Roles('AP_MANAGER', 'ADMIN')
  @Post('escalate-overdue')
  escalateOverdue(@CurrentUser() { tenantId }: Principal) {
    return this.workflowEngine.escalateOverdueSteps(tenantId);
  }

  @Roles('AP_CLERK', 'APPROVER', 'AP_MANAGER', 'CONTROLLER', 'ADMIN')
  @Get(':invoiceId')
  getInstance(@CurrentUser() { tenantId }: Principal, @Param('invoiceId') invoiceId: string) {
    return this.workflowEngine.getInstance(tenantId, invoiceId);
  }

  @Roles('APPROVER', 'AP_MANAGER', 'CONTROLLER')
  @Post('steps/:stepId/decide')
  decideStep(
    @CurrentUser() { tenantId, userId }: Principal,
    @Param('stepId') stepId: string,
    @Body() dto: DecideStepDto,
  ) {
    // The actor is the session, never the body. This is the line that turns the existing
    // assigned-approver check from a politeness into authorization.
    return this.workflowEngine.decideStep(tenantId, stepId, { ...dto, approverId: userId });
  }

  @Roles('APPROVER', 'AP_MANAGER', 'CONTROLLER')
  @Post('steps/:stepId/delegate')
  delegateStep(
    @CurrentUser() { tenantId, userId }: Principal,
    @Param('stepId') stepId: string,
    @Body() dto: DelegateStepDto,
  ) {
    return this.workflowEngine.delegateStep(tenantId, stepId, { ...dto, fromApproverId: userId });
  }
}
