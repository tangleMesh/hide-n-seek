# MongoDB tools + AWS CLI v2: dumps the game database to S3 on a schedule.
# No package installs: the AWS CLI (a self-contained bundle) is copied from its official image.
FROM amazon/aws-cli:2.22.0 AS aws
FROM mongo:8
COPY --from=aws /usr/local/aws-cli /usr/local/aws-cli
RUN ln -s /usr/local/aws-cli/v2/current/bin/aws /usr/local/bin/aws && aws --version
COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh
ENTRYPOINT ["/usr/local/bin/backup.sh"]
CMD ["loop"]
