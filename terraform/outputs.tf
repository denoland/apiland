output "apiland_access_key_id" {
  value = aws_iam_access_key.apiland.id
}

output "apiland_secret_key" {
  value     = aws_iam_access_key.apiland.secret
  sensitive = true
}