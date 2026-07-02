/*
Keep this Terraform root frontend-only without destroying the legacy backend.

These `removed` blocks tell Terraform to forget the old Lambda/API Gateway
resources that still exist in state, while leaving the real AWS resources
untouched. After the next apply, this root will continue managing only the UI
resources (S3, CloudFront, and frontend build/deploy helpers).
*/

removed {
  from = aws_apigatewayv2_api.backend

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_apigatewayv2_integration.backend

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_apigatewayv2_route.default

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_apigatewayv2_stage.default

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_iam_role.backend

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_iam_role.orchestrator

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_iam_role.scheduler

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_iam_role.worker

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_iam_role_policy.orchestrator_invoke

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_iam_role_policy.scheduler_invoke

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_iam_role_policy_attachment.backend_logs

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_iam_role_policy_attachment.backend_vpc

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_iam_role_policy_attachment.orchestrator_logs

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_iam_role_policy_attachment.worker_logs

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_iam_role_policy_attachment.worker_vpc

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_lambda_function.backend

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_lambda_function.orchestrator

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_lambda_function.worker

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_lambda_layer_version.backend_deps

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_lambda_layer_version.deps

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_lambda_permission.apigw_invoke_backend

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_scheduler_schedule.orchestrator

  lifecycle {
    destroy = false
  }
}

removed {
  from = null_resource.build_backend_layer

  lifecycle {
    destroy = false
  }
}

removed {
  from = null_resource.build_layer

  lifecycle {
    destroy = false
  }
}
