terraform {
  backend "gcs" {
    prefix = "terraform"
  }
}

provider "aws" {
  region  = "us-east-1"
  profile = var.aws_profile
}

provider "google" {
  project = var.gcp_project
}

resource "google_storage_bucket" "terraform" {
  name          = "denosr-apiland-terraform"
  location      = "us"
  force_destroy = false

  versioning {
    enabled = true
  }
}