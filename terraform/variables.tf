variable "region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "us-east-1"
}

variable "name_prefix" {
  description = "Prefix applied to the S3 bucket and CloudFront distribution."
  type        = string
  default     = "monitoring-analyzer"
}

variable "cloudfront_price_class" {
  description = "CloudFront price class. PriceClass_100 = US/Canada/Europe (cheapest)."
  type        = string
  default     = "PriceClass_100"
}

variable "backend_alb_domain" {
  description = "Optional public DNS of the backend origin to use for /api/*. If empty or set to REPLACE_ME, Terraform keeps using the legacy API Gateway domain."
  type        = string
  default     = "REPLACE_ME"
}

variable "legacy_backend_origin_domain" {
  description = "Existing backend origin domain already serving /api/* through CloudFront. Used as the safe default for frontend-only deploys."
  type        = string
  default     = "nescvsetj3.execute-api.us-east-1.amazonaws.com"
}

variable "frontend_api_base_url" {
  description = "Backend API base URL baked into the UI at build time, exposed to Vite as VITE_API_BASE_URL. Leave empty to use relative /api/* (recommended — CloudFront routes those to backend_alb_domain)."
  type        = string
  default     = ""
}

variable "pod_origin_domain" {
  description = "Public DNS of the EKS pod (e.g. apm.jiffy.ai or a non-mTLS ALB DNS) that should serve /api/temporal/*. Leave empty to keep temporal calls on the legacy origin."
  type        = string
  default     = ""
}

variable "pod_origin_protocol_policy" {
  description = "Protocol CloudFront should use for the /api/temporal/* origin. Leave empty for auto: ELB DNS names use http-only, custom hostnames use https-only."
  type        = string
  default     = ""
}
