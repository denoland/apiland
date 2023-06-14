
init:
	terraform init -backend-config="bucket=denosr-apiland-terraform"

plan:
	terraform plan -var-file="apiland.tfvars" -out="apiland.tfplan"

apply:
	terraform apply apiland.tfplan

pull-state:
	terraform state pull > apiland.tfstate
