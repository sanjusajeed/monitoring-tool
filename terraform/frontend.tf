data "aws_caller_identity" "current" {}

locals {
  frontend_src_dir = abspath("${path.module}/../react-frontend")
  frontend_dist    = "${local.frontend_src_dir}/dist"
  frontend_bucket  = "${var.name_prefix}-ui-${data.aws_caller_identity.current.account_id}"

  frontend_sources_hash = sha1(join("", concat(
    [for f in fileset("${local.frontend_src_dir}/src", "**") : filesha1("${local.frontend_src_dir}/src/${f}")],
    [for f in fileset("${local.frontend_src_dir}", "public/**") : filesha1("${local.frontend_src_dir}/${f}")],
    [filesha1("${local.frontend_src_dir}/package.json")],
    [filesha1("${local.frontend_src_dir}/vite.config.js")],
    [fileexists("${local.frontend_src_dir}/index.html") ? filesha1("${local.frontend_src_dir}/index.html") : ""],
  )))

  backend_origin_domain = trimspace(var.backend_alb_domain) != "" && trimspace(var.backend_alb_domain) != "REPLACE_ME" ? trimspace(var.backend_alb_domain) : var.legacy_backend_origin_domain
  backend_origin_id     = "apigw-backend"

  pod_enabled       = trimspace(var.pod_origin_domain) != ""
  pod_origin_domain = local.pod_enabled ? trimspace(var.pod_origin_domain) : local.backend_origin_domain
  pod_origin_id     = "pod-backend"

  # FORCE HTTPS for ALB
  pod_origin_protocol_policy = trimspace(var.pod_origin_protocol_policy) != "" ? trimspace(var.pod_origin_protocol_policy) : "https-only"
}

# ─────────────────────────────────────────────────────────────────────────────
# Private S3 bucket — CloudFront is the only accepted reader.
# ─────────────────────────────────────────────────────────────────────────────
resource "aws_s3_bucket" "frontend" {
  bucket        = local.frontend_bucket
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket                  = aws_s3_bucket.frontend.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

# ─────────────────────────────────────────────────────────────────────────────
# Origin Access Control — modern replacement for the deprecated OAI. Scoped
# bucket policy (below) trusts only this distribution's ARN.
# ─────────────────────────────────────────────────────────────────────────────
resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "${var.name_prefix}-ui-oac"
  description                       = "OAC for ${var.name_prefix} UI bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# ─────────────────────────────────────────────────────────────────────────────
# SPA fallback as a CloudFront Function (viewer-request stage). Rewrites
# extensionless, non-/api paths to /index.html so client-side routes resolve
# without relying on a global custom_error_response — that one was catching
# 403/404s coming back from the API origins and serving HTML to /api/* clients.
# ─────────────────────────────────────────────────────────────────────────────
resource "aws_cloudfront_function" "spa_fallback" {
  name    = "${var.name_prefix}-spa-fallback"
  runtime = "cloudfront-js-2.0"
  comment = "Rewrite SPA routes to /index.html; leave /api/* and assets alone"
  publish = true
  code    = <<-EOT
    function handler(event) {
      var request = event.request;
      var uri = request.uri;

      // Never rewrite API calls — they must reach their backend origin.
      if (uri.indexOf('/api/') === 0) return request;

      // Real assets (anything with a file extension) pass through.
      if (uri.match(/\.[a-zA-Z0-9]+$/)) return request;

      // Otherwise treat as SPA route → serve index.html from S3.
      request.uri = '/index.html';
      return request;
    }
  EOT
}

# ─────────────────────────────────────────────────────────────────────────────
# CloudFront distribution.
# SPA fallback: 403/404 → /index.html so React client-side routes work.
# Uses the managed "CachingOptimized" cache policy (gzip/brotli + long TTL)
# and "CORS-S3Origin" origin request policy.
# ─────────────────────────────────────────────────────────────────────────────
resource "aws_cloudfront_distribution" "frontend" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "${var.name_prefix} UI"
  default_root_object = "index.html"
  price_class         = var.cloudfront_price_class

  origin {
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_id                = "s3-frontend"
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }

  # API Gateway backend origin
  origin {
    domain_name = local.backend_origin_domain
    origin_id   = local.backend_origin_id

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # Pod backend origin (/api/temporal/*)
  origin {
    domain_name         = local.pod_origin_domain
    origin_id           = local.pod_origin_id
    connection_attempts = 3
    connection_timeout  = 10

    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = local.pod_origin_protocol_policy
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 60
      origin_keepalive_timeout = 60
    }
  }

  default_cache_behavior {
    target_origin_id         = "s3-frontend"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = "658327ea-f89d-4fab-a63d-7e88639e58f6" # Managed-CachingOptimized
    origin_request_policy_id = "88a5eaf4-2fd4-4709-b370-b4c650ea3fcf" # Managed-CORS-S3Origin

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa_fallback.arn
    }
  }

  # /api/temporal/* → EKS pod (Temporal gRPC SDK code). MUST be declared
  # before /api/* so CloudFront evaluates this more specific path first.
  # When pod_origin_domain is unset, pod_origin_domain falls back to the
  # legacy origin so this behaviour is a no-op.
  ordered_cache_behavior {
    path_pattern             = "/api/temporal/*"
    target_origin_id         = local.pod_origin_id
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # Managed-CachingDisabled
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # Managed-AllViewerExceptHostHeader
  }

  # /api/* → EKS pod (apm-tenant-monitor.jiffy.ai). All FastAPI routes are
  # served by the pod now; the legacy API Gateway / Lambda is no longer in the
  # request path. We keep the more-specific /api/temporal/* behavior above so
  # the precedence order remains explicit, but both currently point at the
  # same pod-backend origin.
  # - CachingDisabled: never cache API responses.
  # - AllViewerExceptHostHeader: forwards cookies, query, method, body, but
  #   sets Host = origin domain so the ALB picks the matching ACM cert.
  ordered_cache_behavior {
    path_pattern             = "/api/*"
    target_origin_id         = local.pod_origin_id
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # Managed-CachingDisabled
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # Managed-AllViewerExceptHostHeader
  }

  # NOTE: no custom_error_response. SPA fallback is now handled per-request by
  # aws_cloudfront_function.spa_fallback (default behavior only). A global
  # custom_error_response would catch real 403/404s coming back from /api/*
  # origins and serve them as 200 + index.html, which silently broke the
  # browser's JSON.parse of API responses.

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

data "aws_iam_policy_document" "frontend" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.frontend.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.frontend.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "frontend" {
  bucket     = aws_s3_bucket.frontend.id
  policy     = data.aws_iam_policy_document.frontend.json
  depends_on = [aws_s3_bucket_public_access_block.frontend]
}

# ─────────────────────────────────────────────────────────────────────────────
# Build + sync + invalidate.
# Runs `npm install && npm run build` when source hash changes, then syncs
# dist/ to S3 and invalidates CloudFront. `aws s3 sync --delete` handles both
# added and removed files in one pass.
# ─────────────────────────────────────────────────────────────────────────────
resource "null_resource" "build_frontend" {
  triggers = {
    sources_hash = local.frontend_sources_hash
    api_base_url = var.frontend_api_base_url
  }

  provisioner "local-exec" {
    command     = "npm install && npm run build"
    working_dir = local.frontend_src_dir
    environment = {
      VITE_API_BASE_URL = var.frontend_api_base_url
    }
  }
}

resource "null_resource" "deploy_frontend" {
  triggers = {
    build_id        = null_resource.build_frontend.id
    distribution_id = aws_cloudfront_distribution.frontend.id
    bucket_id       = aws_s3_bucket.frontend.id
  }

  # Run from inside dist/ so the source argument is just "." — avoids Windows
  # cmd.exe quote-stripping rules eating the second path when the project root
  # contains a space.
  provisioner "local-exec" {
    command     = "aws s3 sync . s3://${aws_s3_bucket.frontend.id} --delete"
    working_dir = local.frontend_dist
  }

  provisioner "local-exec" {
    command = "aws cloudfront create-invalidation --distribution-id ${aws_cloudfront_distribution.frontend.id} --paths /*"
  }

  depends_on = [
    aws_s3_bucket_policy.frontend,
    null_resource.build_frontend,
  ]
}
