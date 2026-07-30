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
