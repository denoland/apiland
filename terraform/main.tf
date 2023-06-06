resource "aws_iam_user" "apiland" {
  name = "${var.environment}-apiland"
  path = "/"

  tags = {
    managed-by = "denoland/apiland/terraform/main.tf"
  }
}

// Policy taken from https://grafana.com/docs/grafana/latest/datasources/aws-apiland/#provision-the-data-source
resource "aws_iam_user_policy" "apiland" {
  name = "${var.environment}-apiland"
  user = aws_iam_user.apiland.name

  policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SQSUserPermissions",
      "Effect": "Allow",
      "Action": [
        "sqs:GetQueueUrl",
        "sqs:ListQueues",
        "sqs:ReceiveMessage",
        "sqs:SendMessage",
        "sqs:SendMessageBatch",
        "sqs:DeleteMessage",
        "sqs:DeleteMessageBatch",
        "sqs:GetQueueAttributes"
      ],
      "Resource": "*"
    },
    {
      "Sid": "S3UserPermissions",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::deno-registry2-prod-moderationbucket-b3a31d16",
        "arn:aws:s3:::deno-registry2-prod-moderationbucket-b3a31d16/*", 
        "arn:aws:s3:::deno-registry2-prod-storagebucket-replication-b3a31d16",
        "arn:aws:s3:::deno-registry2-prod-storagebucket-replication-b3a31d16/*",
        "arn:aws:s3:::deno-registry2-prod-storagebucket-b3a31d16",
        "arn:aws:s3:::deno-registry2-prod-storagebucket-b3a31d16/*"
      ]
    }
  ]
}
EOF
}

resource "aws_iam_access_key" "apiland" {
  user = aws_iam_user.apiland.name
}
