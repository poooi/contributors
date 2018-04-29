mkdir -p /tmp/deploy

openssl aes-256-cbc -K $encrypted_c777cae0c042_key -iv $encrypted_c777cae0c042_iv -in .travis/github-deploy-key.enc -out /tmp/deploy/github-deploy-key -d

chmod 600 /tmp/deploy/github-deploy-key

ssh-keygen -e -f /tmp/deploy/github-deploy-key | head -n 4

eval $(ssh-agent -s)

ssh-add /tmp/deploy/github-deploy-key
