# Keep existing API Gateway for general /api/* traffic
backend_alb_domain = "REPLACE_ME"

# Route only /api/temporal/* to the EKS ingress. Use the public hostname
# so CloudFront sends matching SNI for the ACM cert on the ALB. Route53 has
# this CNAMEd to the ALB.
pod_origin_domain = "apm-tenant-monitor.jiffy.ai"

# Optional override. Leave empty for auto:
# - *.elb.amazonaws.com -> http-only
# - custom hostnames    -> https-only
# pod_origin_protocol_policy = "http-only"

# Keep frontend using relative /api paths so CloudFront handles routing
frontend_api_base_url = ""
