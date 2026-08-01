import { IsIn, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateGlAccountDto {
  @IsString()
  @IsNotEmpty()
  code!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsIn(['EXPENSE', 'ASSET', 'LIABILITY', 'REVENUE'])
  accountType?: string;
}

export class CreateCostCenterDto {
  @IsString()
  @IsNotEmpty()
  code!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  /** The person accountable for the cost centre. */
  @IsOptional()
  @IsUUID()
  ownerId?: string;
}

/** Both are optional so a coder can set one half now and the other later, or clear a mistake. */
export class CodeLineDto {
  @IsOptional()
  @IsUUID()
  glAccountId?: string;

  @IsOptional()
  @IsUUID()
  costCenterId?: string;
}
