import { describe, expect, it } from 'vitest'
import { ansiblePlaybookFilter } from '../src/filters/ansible.ts'
import { awsFilter, gcloudFilter, helmFilter, skopeoFilter } from '../src/filters/cloud-cli.ts'
import { dockerImagesFilter, dockerPsFilter, kubectlGetFilter } from '../src/filters/containers.ts'
import { projectStaticFilter } from '../src/filters/index.ts'
import { psqlFilter } from '../src/filters/psql.ts'
import { pulumiFilter } from '../src/filters/pulumi.ts'
import { terraformInitFilter } from '../src/filters/terraform-init.ts'
import { mayProject } from '../src/economy.ts'
import type { MappedProjection } from '../src/projection-map.ts'
import type { EconomyFilter } from '../src/types.ts'

/** Every line of `raw` that `removed` does not match appears in `text`, in order. */
function keepsAllBut(raw: string, text: string, removed: RegExp) {
  let at = 0
  for (const line of raw.split('\n').filter(line => line !== '' && !removed.test(line))) {
    const found = text.indexOf(line, at)
    expect(found, line).toBeGreaterThanOrEqual(0)
    at = found + line.length
  }
}

/** Every copied span is exactly the source text it claims to be. */
function copiesExactly(source: string, projection: MappedProjection) {
  for (const span of projection.sourceMap.spans) {
    if (span.sourceStart === undefined) continue
    expect(projection.text.slice(span.outputStart, span.outputEnd)).toBe(source.slice(span.sourceStart, span.sourceEnd))
  }
}

/**
 * Table compaction is lossless: line for line, the output has the same cells
 * as the input (cells being what tabs or runs of two or more spaces separate).
 */
function sameCells(raw: string, text: string) {
  const cells = (line: string) => line.trim().split(/\t| {2,}/u).filter(cell => cell !== '')
  const before = raw.split('\n'), after = text.split('\n')
  expect(after).toHaveLength(before.length)
  before.forEach((line, i) => expect(cells(after[i]!), line).toEqual(cells(line)))
}

/** Lines in `text` that are exactly as in `raw` (not compacted). */
const verbatim = (raw: string, text: string) => text.split('\n').filter(line => line !== '' && raw.split('\n').includes(line))

const ansi = (stdout: string) => `\u001b[1m${stdout}`

function leavesAlone(filter: EconomyFilter, command: string, stdout: string, exitCode = 0) {
  expect(filter.project({ command, stdout, exitCode }), `${command}: ${JSON.stringify(stdout.slice(0, 40))}`).toBeUndefined()
}

// ——— samples ———
// Synthetic unless marked: laid out exactly as the tools print them. docker
// uses Go's tabwriter with minwidth 10 and padding 3, kubectl minwidth 6 and
// padding 3, gcloud two spaces between columns, helm's uitable pads every
// cell to its column and joins them with tabs. The docker daemon was not
// running for a real capture, and kubectl is not run against any cluster.

const dockerPs = [
  'CONTAINER ID   IMAGE               COMMAND                  CREATED       STATUS                        PORTS                    NAMES',
  '3f4e8c2a1b9d   nginx:1.27-alpine   "/docker-entrypoint.…"   2 hours ago   Up 2 hours                    0.0.0.0:8080->80/tcp     web',
  '9a8b7c6d5e4f   postgres:16         "docker-entrypoint.s…"   2 hours ago   Up 2 hours (healthy)          0.0.0.0:5432->5432/tcp   db',
  '1c2d3e4f5a6b   redis:7.4           "docker-entrypoint.s…"   2 hours ago   Up 2 hours                    6379/tcp                 cache',
  '7e6f5a4b3c2d   demo/worker:dev     "python -m worker"       3 hours ago   Exited (137) 40 minutes ago                            worker',
  '2b3c4d5e6f7a   demo/migrate:dev    "./migrate.sh"           3 hours ago   Exited (0) 3 hours ago                                 migrate',
  '5d6e7f8a9b0c   busybox:1.36        "sh"                     5 days ago    Created                                                scratch',
  '',
].join('\n')

const composePs = [
  'NAME         IMAGE               COMMAND                  SERVICE   CREATED          STATUS                    PORTS',
  'shop-api-1   shop-api            "uvicorn app:app --h…"   api       10 minutes ago   Up 10 minutes             0.0.0.0:8000->8000/tcp',
  'shop-db-1    postgres:16         "docker-entrypoint.s…"   db        10 minutes ago   Up 10 minutes (healthy)   5432/tcp',
  'shop-web-1   nginx:1.27-alpine   "/docker-entrypoint.…"   web       10 minutes ago   Up 10 minutes             0.0.0.0:8080->80/tcp',
  '',
].join('\n')

const dockerImages = [
  'REPOSITORY     TAG           IMAGE ID       CREATED       SIZE',
  'demo/worker    dev           4f5e6d7c8b9a   3 hours ago   412MB',
  'demo/migrate   dev           8a9b0c1d2e3f   3 hours ago   398MB',
  'nginx          1.27-alpine   a1b2c3d4e5f6   2 weeks ago   47.9MB',
  'postgres       16            b2c3d4e5f6a7   3 weeks ago   432MB',
  'redis          7.4           c3d4e5f6a7b8   3 weeks ago   117MB',
  '<none>         <none>        d4e5f6a7b8c9   4 weeks ago   1.12GB',
  '',
].join('\n')

const kubectlPods = [
  'NAMESPACE     NAME                           READY   STATUS             RESTARTS        AGE',
  'default       api-6b9c5d8f7-q2w3e            0/1     CrashLoopBackOff   7 (2m14s ago)   25m',
  'default       web-7d9c6b8f5d-2xk4p           1/1     Running            0               3d',
  'default       web-7d9c6b8f5d-8hj3k           1/1     Running            0               3d',
  'default       worker-5f7d9b6c4-zx9vb         1/1     Running            1 (2d ago)      3d',
  'kube-system   coredns-7db6d8ff4d-4xk2p       1/1     Running            0               12d',
  'kube-system   coredns-7db6d8ff4d-m7n8q       1/1     Running            0               12d',
  'kube-system   etcd-control-plane             1/1     Running            0               12d',
  'kube-system   kube-apiserver-control-plane   1/1     Running            0               12d',
  'kube-system   kube-proxy-9wz7t               1/1     Running            0               12d',
  '',
].join('\n')

/** `kubectl get all`: one table per kind, a blank line between them. */
const kubectlAll = [
  'NAME                       READY   STATUS    RESTARTS   AGE',
  'pod/web-7d9c6b8f5d-2xk4p   1/1     Running   0          3d',
  'pod/web-7d9c6b8f5d-8hj3k   1/1     Running   0          3d',
  '',
  'NAME                 TYPE           CLUSTER-IP     EXTERNAL-IP   PORT(S)        AGE',
  'service/kubernetes   ClusterIP      10.96.0.1      <none>        443/TCP        12d',
  'service/web          LoadBalancer   10.96.112.40   <pending>     80:31380/TCP   3d',
  '',
  'NAME                  READY   UP-TO-DATE   AVAILABLE   AGE',
  'deployment.apps/web   2/2     2            2           3d',
  '',
].join('\n')

const helmList = [
  'NAME      \tNAMESPACE    \tREVISION\tUPDATED                             \tSTATUS  \tCHART                       \tAPP VERSION',
  'cache     \tdefault      \t3       \t2026-11-20 09:14:02.118227 +0000 UTC\tdeployed\tredis-20.3.0                \t7.4.1      ',
  'db        \tdefault      \t1       \t2026-11-18 16:40:51.902113 +0000 UTC\tdeployed\tpostgresql-16.2.1           \t17.2.0     ',
  'ingress   \tingress-nginx\t5       \t2026-11-21 11:02:37.550912 +0000 UTC\tfailed  \tingress-nginx-4.11.3        \t1.11.3     ',
  'monitoring\tmonitoring   \t2       \t2026-11-19 08:22:10.004417 +0000 UTC\tdeployed\tkube-prometheus-stack-65.1.0\tv0.77.2    ',
  '',
].join('\n')

const gcloudInstances = [
  'NAME     ZONE           MACHINE_TYPE   PREEMPTIBLE  INTERNAL_IP  EXTERNAL_IP  STATUS',
  'api-1    us-central1-a  e2-standard-2               10.128.0.12  34.122.10.4  RUNNING',
  'api-2    us-central1-b  e2-standard-2               10.128.0.13  34.122.10.5  RUNNING',
  'batch-1  us-central1-a  n2-highmem-8   true         10.128.0.40               TERMINATED',
  'bastion  us-central1-c  e2-micro                    10.128.0.2   35.188.4.20  RUNNING',
  '',
].join('\n')

describe('docker-ps', () => {
  it('replaces column padding with one tab between cells, keeping every container and value', () => {
    const result = dockerPsFilter.projectMapped({ command: 'docker ps -a', stdout: dockerPs, exitCode: 0 })!
    copiesExactly(dockerPs, result)
    sameCells(dockerPs, result.text)
    expect(result.text).toContain('CONTAINER ID\tIMAGE\tCOMMAND\tCREATED\tSTATUS\tPORTS\tNAMES\n')
    expect(result.text).toContain('3f4e8c2a1b9d\tnginx:1.27-alpine\t"/docker-entrypoint.…"\t2 hours ago\tUp 2 hours\t0.0.0.0:8080->80/tcp\tweb\n')
    // An empty PORTS cell stays an empty field.
    expect(result.text).toContain('2b3c4d5e6f7a\tdemo/migrate:dev\t"./migrate.sh"\t3 hours ago\tExited (0) 3 hours ago\t\tmigrate\n')
    expect(result.text.length).toBeLessThan(dockerPs.length * 0.75)
    expect(projectStaticFilter({ command: 'docker container ls --all', stdout: dockerPs, exitCode: 0 })?.filter).toBe('docker-ps')
  })

  it('keeps a container that exited with an error, restarts or is unhealthy as docker printed it', () => {
    const projected = dockerPsFilter.project({ command: 'docker ps -a', stdout: dockerPs, exitCode: 0 })!
    expect(verbatim(dockerPs, projected)).toEqual([dockerPs.split('\n')[4]])
    const unhealthy = dockerPs.replace('Up 2 hours (healthy)  ', 'Up 2 hours (unhealthy)')
    expect(verbatim(unhealthy, dockerPsFilter.project({ command: 'docker ps -a', stdout: unhealthy, exitCode: 0 })!)).toHaveLength(2)
    // Only problem rows: nothing is compacted.
    const failing = [dockerPs.split('\n')[0], dockerPs.split('\n')[4], ''].join('\n')
    leavesAlone(dockerPsFilter, 'docker ps -a', failing)
  })

  it('reads docker compose ps the same way', () => {
    const result = dockerPsFilter.projectMapped({ command: 'docker compose ps', stdout: composePs, exitCode: 0 })!
    copiesExactly(composePs, result)
    sameCells(composePs, result.text)
    expect(result.text).toContain('shop-db-1\tpostgres:16\t"docker-entrypoint.s…"\tdb\t10 minutes ago\tUp 10 minutes (healthy)\t5432/tcp\n')
    expect(dockerPsFilter.project({ command: 'docker-compose ps', stdout: composePs, exitCode: 0 })).toBe(result.text)
  })

  it('leaves other layouts, other commands, failures and colored output alone', () => {
    // No containers (header only), -q IDs, a --format template, JSON lines.
    leavesAlone(dockerPsFilter, 'docker ps', dockerPs.split('\n')[0] + '\n')
    leavesAlone(dockerPsFilter, 'docker ps -q', '3f4e8c2a1b9d\n9a8b7c6d5e4f\n1c2d3e4f5a6b\n')
    leavesAlone(dockerPsFilter, "docker ps --format '{{.Names}}  {{.Status}}'", 'web  Up 2 hours\ndb  Up 2 hours\n')
    leavesAlone(dockerPsFilter, 'docker ps --format json', '{"Command":"\\"sh\\"","ID":"5d6e7f8a9b0c","Names":"scratch"}\n')
    // A row off the header's columns, or text right after the table: not a table docker printed.
    leavesAlone(dockerPsFilter, 'docker ps -a', dockerPs.replace('nginx:1.27-alpine   "/docker', 'nginx:1.27-alpine  "/docker'))
    leavesAlone(dockerPsFilter, 'docker ps -a', dockerPs + 'trailing note\n')
    leavesAlone(dockerPsFilter, 'docker ps', dockerPs, 1)
    leavesAlone(dockerPsFilter, 'docker ps', ansi(dockerPs))
    for (const command of ['docker inspect web', 'docker images', 'docker compose logs', 'podman ps']) leavesAlone(dockerPsFilter, command, dockerPs)
  })
})

describe('docker-images', () => {
  it('replaces column padding with one tab between cells, keeping every image', () => {
    const result = dockerImagesFilter.projectMapped({ command: 'docker images', stdout: dockerImages, exitCode: 0 })!
    copiesExactly(dockerImages, result)
    sameCells(dockerImages, result.text)
    expect(result.text).toContain('REPOSITORY\tTAG\tIMAGE ID\tCREATED\tSIZE\ndemo/worker\tdev\t4f5e6d7c8b9a\t3 hours ago\t412MB\n')
    expect(result.text).toContain('<none>\t<none>\td4e5f6a7b8c9\t4 weeks ago\t1.12GB\n')
    expect(projectStaticFilter({ command: 'docker image ls', stdout: dockerImages, exitCode: 0 })?.filter).toBe('docker-images')
  })

  it('leaves other commands, quiet and colored output alone', () => {
    leavesAlone(dockerImagesFilter, 'docker images -q', '4f5e6d7c8b9a\n8a9b0c1d2e3f\n')
    leavesAlone(dockerImagesFilter, 'docker images', ansi(dockerImages))
    leavesAlone(dockerImagesFilter, 'docker ps', dockerImages)
    leavesAlone(dockerImagesFilter, 'docker image inspect nginx', dockerImages)
  })
})

describe('kubectl-get', () => {
  it('compacts the pod table and keeps a pod in CrashLoopBackOff as kubectl printed it', () => {
    const result = kubectlGetFilter.projectMapped({ command: 'kubectl get pods -A', stdout: kubectlPods, exitCode: 0 })!
    copiesExactly(kubectlPods, result)
    sameCells(kubectlPods, result.text)
    expect(result.text).toContain('NAMESPACE\tNAME\tREADY\tSTATUS\tRESTARTS\tAGE\n')
    expect(result.text).toContain('default\tworker-5f7d9b6c4-zx9vb\t1/1\tRunning\t1 (2d ago)\t3d\n')
    expect(verbatim(kubectlPods, result.text)).toEqual(['default       api-6b9c5d8f7-q2w3e            0/1     CrashLoopBackOff   7 (2m14s ago)   25m'])
    expect(result.text.length).toBeLessThan(kubectlPods.length * 0.7)
  })

  it('compacts each table of a multi-kind listing, and keeps Pending, Error and NotReady rows', () => {
    const result = kubectlGetFilter.projectMapped({ command: 'kubectl get all', stdout: kubectlAll, exitCode: 0 })!
    sameCells(kubectlAll, result.text)
    expect(result.text).toContain('NAME\tTYPE\tCLUSTER-IP\tEXTERNAL-IP\tPORT(S)\tAGE\nservice/kubernetes\tClusterIP\t10.96.0.1\t<none>\t443/TCP\t12d\n')
    expect(result.text).toContain('\n\nNAME\tREADY\tUP-TO-DATE\tAVAILABLE\tAGE\ndeployment.apps/web\t2/2\t2\t2\t3d\n')
    // `<pending>` external IP: kept as printed.
    expect(verbatim(kubectlAll, result.text)).toContain('service/web          LoadBalancer   10.96.112.40   <pending>     80:31380/TCP   3d')
    const nodes = 'NAME       STATUS     ROLES           AGE   VERSION\ncp-1       Ready      control-plane   12d   v1.31.2\nworker-1   Ready      <none>          12d   v1.31.2\nworker-2   NotReady   <none>          12d   v1.31.2\n'
    expect(kubectlGetFilter.project({ command: 'kubectl get nodes', stdout: nodes, exitCode: 0 }))
      .toBe('NAME\tSTATUS\tROLES\tAGE\tVERSION\ncp-1\tReady\tcontrol-plane\t12d\tv1.31.2\nworker-1\tReady\t<none>\t12d\tv1.31.2\nworker-2   NotReady   <none>          12d   v1.31.2\n')
  })

  it('removes the layout whitespace of -o json, keeping every field', () => {
    const list = { apiVersion: 'v1', items: [{ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'web-7d9c6b8f5d-2xk4p', namespace: 'default', labels: { app: 'web' } },
      status: { phase: 'Running', containerStatuses: [{ name: 'web', ready: true, restartCount: 0, state: { running: { startedAt: '2026-11-19T08:00:00Z' } } }] } }],
    kind: 'List', metadata: { resourceVersion: '' } }
    const stdout = JSON.stringify(list, null, 4) + '\n'
    for (const command of ['kubectl get pods -o json', 'kubectl get pods -ojson', 'kubectl get pods --output=json', 'kubectl -n default get pods -o json']) {
      const text = kubectlGetFilter.project({ command, stdout, exitCode: 0 })!
      expect(JSON.parse(text), command).toEqual(list)
      expect(text).toBe(JSON.stringify(list))
    }
  })

  it('leaves YAML, names, watches, other subcommands and colored output alone', () => {
    leavesAlone(kubectlGetFilter, 'kubectl get pods -o yaml', 'apiVersion: v1\nitems:\n- kind: Pod\n')
    leavesAlone(kubectlGetFilter, 'kubectl get pods -o name', 'pod/web-7d9c6b8f5d-2xk4p\npod/web-7d9c6b8f5d-8hj3k\n')
    leavesAlone(kubectlGetFilter, 'kubectl get pods -w', kubectlPods)
    leavesAlone(kubectlGetFilter, 'kubectl get pods --no-headers', kubectlPods.split('\n').slice(1).join('\n'))
    leavesAlone(kubectlGetFilter, 'kubectl get pods', 'No resources found in default namespace.\n')
    leavesAlone(kubectlGetFilter, 'kubectl get pods', ansi(kubectlPods))
    leavesAlone(kubectlGetFilter, 'kubectl get pods', kubectlPods, 1)
    for (const command of ['kubectl describe pods', 'kubectl top pods', 'oc get pods', 'kubectl logs web']) leavesAlone(kubectlGetFilter, command, kubectlPods)
  })
})

describe('helm', () => {
  it('drops the padding before each tab of helm list, keeping every tab, release and value', () => {
    const result = helmFilter.projectMapped({ command: 'helm list -A', stdout: helmList, exitCode: 0 })!
    copiesExactly(helmList, result)
    sameCells(helmList, result.text)
    expect(result.text).toContain('NAME\tNAMESPACE\tREVISION\tUPDATED\tSTATUS\tCHART\tAPP VERSION\n')
    expect(result.text).toContain('cache\tdefault\t3\t2026-11-20 09:14:02.118227 +0000 UTC\tdeployed\tredis-20.3.0\t7.4.1\n')
    // A failed release keeps its layout.
    expect(verbatim(helmList, result.text)).toEqual([helmList.split('\n')[3]])
    expect(result.text.split('\n').map(line => line.split('\t').length)).toEqual(helmList.split('\n').map(line => line.split('\t').length))
    expect(projectStaticFilter({ command: 'helm -n monitoring ls', stdout: helmList, exitCode: 0 })?.filter).toBe('helm')
  })

  it('reads history, search and repo list tables', () => {
    const history = 'REVISION\tUPDATED                 \tSTATUS    \tCHART       \tAPP VERSION\tDESCRIPTION     \n1       \tMon Nov 16 10:30:00 2026\tsuperseded\tredis-20.2.0\t7.4.0      \tInstall complete\n2       \tWed Nov 18 11:00:00 2026\tsuperseded\tredis-20.2.1\t7.4.0      \tUpgrade complete\n3       \tFri Nov 20 09:14:02 2026\tdeployed  \tredis-20.3.0\t7.4.1      \tUpgrade complete\n'
    expect(helmFilter.project({ command: 'helm history cache', stdout: history, exitCode: 0 }))
      .toBe('REVISION\tUPDATED\tSTATUS\tCHART\tAPP VERSION\tDESCRIPTION\n1\tMon Nov 16 10:30:00 2026\tsuperseded\tredis-20.2.0\t7.4.0\tInstall complete\n2\tWed Nov 18 11:00:00 2026\tsuperseded\tredis-20.2.1\t7.4.0\tUpgrade complete\n3\tFri Nov 20 09:14:02 2026\tdeployed\tredis-20.3.0\t7.4.1\tUpgrade complete\n')
    const repos = 'NAME         \tURL                                        \nbitnami      \thttps://charts.bitnami.com/bitnami         \ningress-nginx\thttps://kubernetes.github.io/ingress-nginx\n'
    expect(helmFilter.project({ command: 'helm repo list', stdout: repos, exitCode: 0 }))
      .toBe('NAME\tURL\nbitnami\thttps://charts.bitnami.com/bitnami\ningress-nginx\thttps://kubernetes.github.io/ingress-nginx\n')
    expect(helmFilter.commands!('helm search repo redis')).toBe(true)
  })

  // Adapted from RTK's helm filter tests (Apache-2.0, see third-party/rtk).
  it('leaves release reports, ragged tables, other commands and colored output alone', () => {
    const status = 'NAME: my-release\nLAST DEPLOYED: Mon Jan 15 10:30:00 2024\nNAMESPACE: default\nSTATUS: deployed\nREVISION: 3\n\nNOTES:\nApplication is running.\n'
    for (const command of ['helm status my-release', 'helm install my-release ./chart', 'helm upgrade my-release ./chart']) leavesAlone(helmFilter, command, status)
    leavesAlone(helmFilter, 'helm list', helmList.replace('cache     \t', 'cache  \t'))
    leavesAlone(helmFilter, 'helm list', 'NAME\tNAMESPACE\tREVISION\tUPDATED\tSTATUS\tCHART\tAPP VERSION\n')
    leavesAlone(helmFilter, 'helm list -o json', '[{"name":"cache","namespace":"default","revision":"3"}]\n')
    leavesAlone(helmFilter, 'helm list', ansi(helmList))
    leavesAlone(helmFilter, 'kubectl get pods', helmList)
  })
})

describe('aws', () => {
  // Adapted from RTK's tests/fixtures/aws_backup_describe_global_settings.json (Apache-2.0, see third-party/rtk).
  const settings = '{\n    "GlobalSettings": {\n        "isCrossAccountBackupEnabled": "false",\n        "isDelegatedAdministratorEnabled": "false",\n        "isMpaEnabled": "false"\n    },\n    "LastUpdateTime": "2026-05-28T09:52:17.525000+02:00"\n}\n'

  it('removes JSON layout whitespace, keeping every key, value and order', () => {
    const result = awsFilter.projectMapped({ command: 'aws backup describe-global-settings', stdout: settings, exitCode: 0 })!
    copiesExactly(settings, result)
    expect(result.text).toBe('{"GlobalSettings":{"isCrossAccountBackupEnabled":"false","isDelegatedAdministratorEnabled":"false","isMpaEnabled":"false"},"LastUpdateTime":"2026-05-28T09:52:17.525000+02:00"}')
    // Synthetic describe-instances, indented by four spaces as the CLI prints it; strings with spaces stay whole.
    const instances = { Reservations: [{ Instances: [{ InstanceId: 'i-0a1b2c3d4e5f00001', State: { Code: 16, Name: 'running' }, Tags: [{ Key: 'Name', Value: 'web server 1' }], StateReason: { Message: 'Client.UserInitiatedShutdown: User initiated shutdown' } }] }] }
    const stdout = JSON.stringify(instances, null, 4) + '\n'
    const text = projectStaticFilter({ command: 'aws ec2 describe-instances --region us-east-1', stdout, exitCode: 0 })!
    expect(text.filter).toBe('aws')
    expect(JSON.parse(text.text)).toEqual(instances)
    expect(text.text).toContain('"Value":"web server 1"')
  })

  it('leaves text, table and YAML output, errors and other commands alone', () => {
    leavesAlone(awsFilter, 'aws ec2 describe-instances --output text', 'RESERVATIONS\t123456789012\tr-0abc\n')
    leavesAlone(awsFilter, 'aws ec2 describe-instances --output table', '-------------------\n|DescribeInstances|\n+-----------------+\n')
    leavesAlone(awsFilter, 'aws sts get-caller-identity', settings.replace('{', '{{'))
    leavesAlone(awsFilter, 'aws sts get-caller-identity', settings, 254)
    leavesAlone(awsFilter, 'aws ec2 describe-vpcs --query Vpcs[0].VpcId', '"vpc-0abc"\n')
    leavesAlone(awsFilter, 'aws s3 ls', settings)
    leavesAlone(awsFilter, 'gcloud projects list', settings)
    expect(awsFilter.commands!('aws s3 ls s3://bucket')).toBe(false)
    expect(awsFilter.commands!('aws ec2 describe-instances --output yaml')).toBe(false)
  })
})

describe('gcloud', () => {
  it('compacts list tables, empty cells included', () => {
    const result = gcloudFilter.projectMapped({ command: 'gcloud compute instances list', stdout: gcloudInstances, exitCode: 0 })!
    copiesExactly(gcloudInstances, result)
    sameCells(gcloudInstances, result.text)
    expect(result.text).toContain('api-1\tus-central1-a\te2-standard-2\t\t10.128.0.12\t34.122.10.4\tRUNNING\n')
    expect(result.text).toContain('batch-1\tus-central1-a\tn2-highmem-8\ttrue\t10.128.0.40\t\tTERMINATED\n')
  })

  // Adapted from RTK's gcloud filter tests (Apache-2.0, see third-party/rtk).
  it('keeps the lines around a table verbatim', () => {
    const rtk = 'Updated property [core/project].\n\nNAME        REGION        STATUS\nmy-cluster  us-central1   RUNNING\n'
    expect(gcloudFilter.project({ command: 'gcloud container clusters list', stdout: rtk, exitCode: 0 }))
      .toBe('Updated property [core/project].\n\nNAME\tREGION\tSTATUS\nmy-cluster\tus-central1\tRUNNING\n')
    leavesAlone(gcloudFilter, 'gcloud container clusters list', 'Listed 0 items.')
  })

  it('removes the layout whitespace of --format=json', () => {
    const projects = [{ createTime: '2026-01-10T09:00:00.000Z', lifecycleState: 'ACTIVE', name: 'demo shop', projectId: 'demo-shop-412', projectNumber: '123456789012' }]
    const stdout = JSON.stringify(projects, null, 2) + '\n'
    for (const command of ['gcloud projects list --format=json', 'gcloud projects describe demo-shop-412 --format json']) {
      expect(JSON.parse(gcloudFilter.project({ command, stdout, exitCode: 0 })!), command).toEqual(projects)
    }
  })

  it('leaves YAML descriptions, values, other tools and colored output alone', () => {
    leavesAlone(gcloudFilter, 'gcloud compute instances describe api-1', 'name: api-1\nstatus: RUNNING\nzone: us-central1-a\n')
    leavesAlone(gcloudFilter, 'gcloud compute instances list --format=value(name)', 'api-1\napi-2\n')
    leavesAlone(gcloudFilter, 'gcloud compute instances list', ansi(gcloudInstances))
    leavesAlone(gcloudFilter, 'gcloud compute instances list', gcloudInstances, 1)
    leavesAlone(gcloudFilter, 'gsutil ls', gcloudInstances)
  })
})

describe('skopeo', () => {
  const digest = (n: number) => `sha256:${n.toString(16).padStart(4, '0').repeat(16)}`
  const copy = ['Getting image source signatures', ...[1, 2, 3, 4, 5].map(n => `Copying blob ${digest(n)}`), `Copying config ${digest(9)}`, 'Writing manifest to image destination', ''].join('\n')

  it('folds the blob rows of a copy, keeping the config, manifest and signature lines', () => {
    const result = skopeoFilter.projectMapped({ command: 'skopeo copy docker://docker.io/library/nginx:1.27 oci:/tmp/nginx:1.27', stdout: copy, exitCode: 0 })!
    copiesExactly(copy, result)
    expect(result.text).toBe(`Getting image source signatures\n[5 blob copy lines omitted]\nCopying config ${digest(9)}\nWriting manifest to image destination\n`)
    keepsAllBut(copy, result.text, /^Copying blob /u)
  })

  it('removes the layout whitespace of inspect JSON, keeping every tag and layer', () => {
    const image = { Name: 'docker.io/library/nginx', Digest: digest(7), RepoTags: ['1.27', '1.27-alpine', 'latest'], Architecture: 'amd64', Os: 'linux',
      Layers: [digest(1), digest(2)], Env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'NGINX_VERSION=1.27.3'] }
    const stdout = JSON.stringify(image, null, 4) + '\n'
    expect(JSON.parse(skopeoFilter.project({ command: 'skopeo inspect docker://docker.io/library/nginx:1.27', stdout, exitCode: 0 })!)).toEqual(image)
    expect(JSON.parse(skopeoFilter.project({ command: 'skopeo list-tags docker://docker.io/library/nginx', stdout, exitCode: 0 })!)).toEqual(image)
  })

  // Adapted from RTK's skopeo filter tests (Apache-2.0, see third-party/rtk).
  it('leaves short copies, failures, templates and other commands alone', () => {
    const rtk = 'Getting image source signatures\nCopying blob sha256:abc123 done\nCopying blob sha256:def456 done\nCopying config sha256:789ghi done\nWriting manifest to image destination\nStoring signatures\n'
    leavesAlone(skopeoFilter, 'skopeo copy docker://a docker://b', rtk)
    leavesAlone(skopeoFilter, 'skopeo copy docker://a docker://b', copy, 1)
    leavesAlone(skopeoFilter, 'skopeo copy docker://a docker://b', ansi(copy))
    leavesAlone(skopeoFilter, "skopeo inspect --format '{{.Digest}}' docker://a", `${digest(7)}\n`)
    leavesAlone(skopeoFilter, 'skopeo delete docker://a', copy)
    leavesAlone(skopeoFilter, 'crane copy a b', copy)
  })
})

/** A first `terraform init -no-color` with three providers, in Terraform 1.x's wording. */
const tfInit = [
  '',
  'Initializing the backend...',
  '',
  'Initializing provider plugins...',
  '- Finding hashicorp/aws versions matching "~> 5.0"...',
  '- Finding hashicorp/random versions matching "3.6.0"...',
  '- Finding latest version of hashicorp/null...',
  '- Installing hashicorp/aws v5.31.0...',
  '- Installed hashicorp/aws v5.31.0 (signed by HashiCorp)',
  '- Installing hashicorp/random v3.6.0...',
  '- Installed hashicorp/random v3.6.0 (signed by HashiCorp)',
  '- Installing hashicorp/null v3.2.2...',
  '- Installed hashicorp/null v3.2.2 (signed by HashiCorp)',
  '',
  'Terraform has created a lock file .terraform.lock.hcl to record the provider',
  'selections it made above. Include this file in your version control repository',
  'so that Terraform can guarantee to make the same selections by default when',
  'you run "terraform init" in the future.',
  '',
  'Terraform has been successfully initialized!',
  '',
  'You may now begin working with Terraform. Try running "terraform plan" to see',
  'any changes that are required for your infrastructure. All Terraform commands',
  'should now work.',
  '',
  'If you ever set or change modules or backend configuration for Terraform,',
  'rerun this command to reinitialize your working directory. If you forget, other',
  'commands will detect it and remind you to do so if necessary.',
  '',
].join('\n')
const LOOKUP_OR_ADVICE = /^- (?:Finding|Installing|Reusing)|^You may now|^any changes|^should now|^If you ever|^rerun this|^commands will/u

describe('terraform-init', () => {
  it('folds provider lookup and download rows and the closing advice, keeping each installed version', () => {
    const result = terraformInitFilter.projectMapped({ command: 'terraform init -no-color', stdout: tfInit, exitCode: 0 })!
    copiesExactly(tfInit, result)
    keepsAllBut(tfInit, result.text, LOOKUP_OR_ADVICE)
    expect(result.text).toContain('Initializing provider plugins...\n[6 provider lookup and download progress lines omitted]\n- Installed hashicorp/aws v5.31.0 (signed by HashiCorp)\n- Installed hashicorp/random v3.6.0 (signed by HashiCorp)\n')
    expect(result.text).toContain('Terraform has been successfully initialized!\n\n[7 lines of next-step advice omitted]\n')
    expect(result.text).not.toContain('Finding')
    expect(projectStaticFilter({ command: 'cd ./infra && terraform init', stdout: tfInit, exitCode: 0 })?.filter).toBe('terraform-init')
  })

  it('reads a re-init from the lock file and OpenTofu\'s wording', () => {
    const tofu = tfInit.replaceAll('Terraform', 'OpenTofu').replaceAll('"terraform', '"tofu')
      .replace(/- Finding[\s\S]*?\(signed by HashiCorp\)\n(?:- I[^\n]*\n)*/u, [
        '- Reusing previous version of hashicorp/aws from the dependency lock file',
        '- Reusing previous version of hashicorp/random from the dependency lock file',
        '- Using previously-installed hashicorp/aws v5.31.0',
        '- Using previously-installed hashicorp/random v3.6.0', ''].join('\n'))
    const text = terraformInitFilter.project({ command: 'tofu init', stdout: tofu, exitCode: 0 })!
    expect(text).toContain('[2 provider lookup and download progress lines omitted]\n- Using previously-installed hashicorp/aws v5.31.0\n- Using previously-installed hashicorp/random v3.6.0\n')
    expect(text).toContain('OpenTofu has been successfully initialized!\n\n[7 lines of next-step advice omitted]\n')
    keepsAllBut(tofu, text, LOOKUP_OR_ADVICE)
  })

  it('keeps warnings and rows that mention a problem', () => {
    const warned = tfInit.replace('- Finding latest version of hashicorp/null...', '- Finding latest version of demo/failover...')
      .replace('\nTerraform has been', '\n╷\n│ Warning: Incomplete lock file information for providers\n│ \n│ Due to your customized provider installation methods, Terraform was forced\n╵\n\nTerraform has been')
    const text = terraformInitFilter.project({ command: 'terraform init', stdout: warned, exitCode: 0 })!
    expect(text).toContain('[5 provider lookup and download progress lines omitted]\n- Finding latest version of demo/failover...\n')
    expect(text).toContain('│ Warning: Incomplete lock file information for providers\n')
    keepsAllBut(warned, text, LOOKUP_OR_ADVICE)
  })

  // Adapted from RTK's tofu-init filter tests (Apache-2.0, see third-party/rtk).
  it('leaves failed inits, unknown wording, other subcommands and colored output alone', () => {
    leavesAlone(terraformInitFilter, 'terraform init', tfInit, 1)
    leavesAlone(terraformInitFilter, 'terraform init', tfInit.replace('Terraform has been successfully initialized!', 'Error: Failed to query available provider packages'))
    // RTK's sample: versions without the `v` Terraform prints, and no advice paragraphs; nothing it knows to fold.
    leavesAlone(terraformInitFilter, 'tofu init', 'Initializing the backend...\nInitializing provider plugins...\n- Downloading hashicorp/aws 5.0.0...\n- Installing hashicorp/aws 5.0.0...\n- Using previously-installed hashicorp/random 3.5.1\n\nOpenTofu has been successfully initialized!\n')
    leavesAlone(terraformInitFilter, 'terraform init', ansi(tfInit))
    for (const command of ['terraform plan', 'tofu validate', 'terragrunt init']) leavesAlone(terraformInitFilter, command, tfInit)
  })
})

describe('pulumi', () => {
  // Adapted from RTK's pulumi-up filter tests (Apache-2.0, see third-party/rtk).
  const up = 'Updating (dev)\n\nView in Browser (Ctrl+O): https://app.pulumi.com/org/my-proj/dev/updates/42\n\n     Type                          Name              Status\n +   pulumi:pulumi:Stack           my-proj-dev       created\n +   └─ aws:s3:Bucket              my-bucket         created\n\nOutputs:\n    bucket_name: "my-bucket-abc123"\n\nResources:\n    + 2 created\n\nDuration: 15s\n'
  /** A preview with a nested tree, a replacement, an Info column and a diagnostic. */
  const preview = [
    'Previewing update (dev)',
    '',
    'View in Browser (Ctrl+O): https://app.pulumi.com/demo/shop/dev/previews/4c1f0e2a',
    '',
    '     Type                    Name      Plan     Info',
    ' +   pulumi:pulumi:Stack     shop-dev  create',
    ' +   ├─ aws:ec2:Vpc          main      create',
    ' +   │  ├─ aws:ec2:Subnet    public-a  create',
    ' +   │  └─ aws:ec2:Subnet    public-b  create',
    ' ~   ├─ aws:s3:BucketV2      assets    update   [diff: ~tags]',
    ' +-  ├─ aws:rds:Instance     db        replace  [diff: ~engineVersion]',
    ' +   └─ aws:lambda:Function  resize    create   1 error',
    '',
    'Diagnostics:',
    '  aws:lambda:Function (resize):',
    '    error: archive path "./dist/resize.zip" does not exist',
    '',
    'Resources:',
    '    + 6 to create',
    '    ~ 1 to update',
    '    +-1 to replace',
    '    8 changes. 1 unchanged',
    '',
  ].join('\n')

  it('compacts the resource table, keeping change symbols, tree prefixes and every line around it', () => {
    const result = pulumiFilter.projectMapped({ command: 'pulumi up --yes', stdout: up, exitCode: 0 })!
    copiesExactly(up, result)
    sameCells(up, result.text)
    expect(result.text).toContain('\n     Type\tName\tStatus\n +   pulumi:pulumi:Stack\tmy-proj-dev\tcreated\n +   └─ aws:s3:Bucket\tmy-bucket\tcreated\n\nOutputs:\n')
    expect(result.text).toContain('View in Browser (Ctrl+O): https://app.pulumi.com/org/my-proj/dev/updates/42\n')
    expect(result.text).toContain('Duration: 15s\n')
    for (const command of ['pulumi destroy --yes', 'pulumi refresh', 'pulumi -C infra up']) expect(pulumiFilter.project({ command, stdout: up, exitCode: 0 }), command).toBe(result.text)
  })

  it('keeps a row with an error as pulumi printed it, and the diagnostics verbatim', () => {
    const result = pulumiFilter.projectMapped({ command: 'pulumi preview', stdout: preview, exitCode: 255 })!
    sameCells(preview, result.text)
    expect(result.text).toContain(' +   │  ├─ aws:ec2:Subnet\tpublic-a\tcreate\n')
    expect(result.text).toContain(' +-  ├─ aws:rds:Instance\tdb\treplace\t[diff: ~engineVersion]\n')
    expect(verbatim(preview, result.text)).toContain(' +   └─ aws:lambda:Function  resize    create   1 error')
    keepsAllBut(preview, result.text, /^ (?:[+~-]|\+-) {2,3}\S|^ {5}Type/u)
  })

  // Adapted from RTK's pulumi-stack filter tests (Apache-2.0, see third-party/rtk).
  it('compacts the listings of pulumi stack', () => {
    const stack = 'Current stack is dev:\n    Managed by my-user\n    Owner: my-org\n    Last updated: 2 hours ago\n    Pulumi version used: v3.120.0\n\nCurrent stack resources (3):\n    TYPE                          NAME\n    pulumi:pulumi:Stack           my-proj-dev\n    aws:s3:Bucket                 my-bucket\n    aws:iam:Role                  my-role\n'
    expect(pulumiFilter.project({ command: 'pulumi stack', stdout: stack, exitCode: 0 }))
      .toBe('Current stack is dev:\n    Managed by my-user\n    Owner: my-org\n    Last updated: 2 hours ago\n    Pulumi version used: v3.120.0\n\nCurrent stack resources (3):\n    TYPE\tNAME\n    pulumi:pulumi:Stack\tmy-proj-dev\n    aws:s3:Bucket\tmy-bucket\n    aws:iam:Role\tmy-role\n')
    const ls = 'NAME  LAST UPDATE    RESOURCE COUNT  URL\ndev*  5 minutes ago  4               https://app.pulumi.com/demo/shop/dev\nprod  2 weeks ago    12              https://app.pulumi.com/demo/shop/prod\n'
    expect(pulumiFilter.project({ command: 'pulumi stack ls', stdout: ls, exitCode: 0 }))
      .toBe('NAME\tLAST UPDATE\tRESOURCE COUNT\tURL\ndev*\t5 minutes ago\t4\thttps://app.pulumi.com/demo/shop/dev\nprod\t2 weeks ago\t12\thttps://app.pulumi.com/demo/shop/prod\n')
  })

  // Adapted from RTK's pulumi-destroy filter tests (Apache-2.0, see third-party/rtk).
  it('leaves output without a table, other commands and colored output alone', () => {
    leavesAlone(pulumiFilter, 'pulumi destroy', 'Destroying (dev)\n\nView in Browser (Ctrl+O): https://app.pulumi.com/org/my-proj/dev/updates/43\n\nDuration: 1s\n')
    leavesAlone(pulumiFilter, 'pulumi stack', 'No stacks found in the current workspace.\n')
    leavesAlone(pulumiFilter, 'pulumi up', ansi(up))
    for (const command of ['pulumi config', 'pulumi logs', 'terraform plan']) leavesAlone(pulumiFilter, command, up)
  })
})

const banner = (title: string) => `${title} ${'*'.repeat(79 - title.length)}`
/** ansible-playbook's default callback, four hosts, one of them failing. */
const playbook = [
  '',
  banner('PLAY [webservers]'),
  '',
  banner('TASK [Gathering Facts]'),
  'ok: [web01]', 'ok: [web02]', 'ok: [web03]', 'ok: [web04]',
  '[WARNING]: Platform linux on host web01 is using the discovered Python interpreter at /usr/bin/python3.11, but future installation of another Python interpreter could change the meaning of that path.',
  '',
  banner('TASK [Fail if the release is unsupported]'),
  'skipping: [web01]', 'skipping: [web02]', 'skipping: [web03]', 'skipping: [web04]',
  '',
  banner('TASK [Install packages]'),
  'ok: [web01] => (item=git)', 'ok: [web02] => (item=git)', 'ok: [web03] => (item=git)', 'ok: [web04] => (item=git)',
  'changed: [web02] => (item=htop)', 'ok: [web01] => (item=htop)', 'ok: [web03] => (item=htop)', 'ok: [web04] => (item=htop)',
  '',
  banner('TASK [Configure TLS]'),
  'skipping: [web01]', 'skipping: [web02]', 'ok: [web04]',
  'fatal: [web03]: FAILED! => {"changed": false, "msg": "Unable to find the TLS bundle /etc/ssl/site.pem"}',
  '',
  banner('TASK [Show release]'),
  'ok: [web01] => {', '    "msg": "release 2.4.1"', '}',
  'ok: [web02] => {', '    "msg": "release 2.4.1"', '}',
  '',
  banner('RUNNING HANDLER [restart nginx]'),
  'changed: [web02]',
  '',
  banner('PLAY RECAP'),
  'web01                      : ok=5    changed=0    unreachable=0    failed=0    skipped=2    rescued=0    ignored=0   ',
  'web02                      : ok=6    changed=2    unreachable=0    failed=0    skipped=2    rescued=0    ignored=0   ',
  'web03                      : ok=2    changed=0    unreachable=0    failed=1    skipped=1    rescued=0    ignored=0   ',
  'web04                      : ok=4    changed=0    unreachable=0    failed=0    skipped=1    rescued=0    ignored=0   ',
  '',
].join('\n')
const HOST_ROWS = /^(?:ok|skipping): \[[^\]]+\](?: => \(item=.*\))?$|\*{4}$/u

describe('ansible-playbook', () => {
  it('folds ok and skipping host rows with counts and shortens banners, keeping changes, failures and the recap', () => {
    const result = ansiblePlaybookFilter.projectMapped({ command: 'ansible-playbook -i inventory.ini site.yml', stdout: playbook, exitCode: 2 })!
    copiesExactly(playbook, result)
    keepsAllBut(playbook, result.text, HOST_ROWS)
    expect(result.text).toContain('TASK [Gathering Facts] ***\n[4 ok host rows omitted]\n[WARNING]: Platform linux')
    expect(result.text).toContain('TASK [Install packages] ***\n[4 ok host rows omitted]\nchanged: [web02] => (item=htop)\n[3 ok host rows omitted]\n')
    expect(result.text).toContain('TASK [Configure TLS] ***\n[1 ok, 2 skipping host rows omitted]\nfatal: [web03]: FAILED!')
    expect(result.text).toContain('TASK [Show release] ***\nok: [web01] => {\n    "msg": "release 2.4.1"\n}\nok: [web02] => {\n')
    expect(result.text).toContain('RUNNING HANDLER [restart nginx] ***\nchanged: [web02]\n\nPLAY RECAP ***\nweb01                      : ok=5    changed=0    unreachable=0    failed=0')
    // A banner that names a problem keeps its stars; its host rows are folded like any other.
    expect(result.text).toContain(`${banner('TASK [Fail if the release is unsupported]')}\n[4 skipping host rows omitted]\n`)
    expect(result.text.length).toBeLessThan(playbook.length * 0.7)
  })

  // Adapted from RTK's ansible-playbook filter tests (Apache-2.0, see third-party/rtk).
  it('keeps short runs and every failure in RTK\'s sample, shortening only the banners', () => {
    const rtk = 'PLAY [all] *********************************************************************\n\nTASK [Gathering Facts] *********************************************************\nok: [web01]\nok: [web02]\n\nTASK [Install nginx] ***********************************************************\nchanged: [web01]\nskipping: [web02]\n\nPLAY RECAP *********************************************************************\nweb01                      : ok=2    changed=1    unreachable=0    failed=0\nweb02                      : ok=1    changed=0    unreachable=0    failed=0\n'
    expect(ansiblePlaybookFilter.project({ command: 'ansible-playbook site.yml', stdout: rtk, exitCode: 0 }))
      .toBe('PLAY [all] ***\n\nTASK [Gathering Facts] ***\nok: [web01]\nok: [web02]\n\nTASK [Install nginx] ***\nchanged: [web01]\nskipping: [web02]\n\nPLAY RECAP ***\nweb01                      : ok=2    changed=1    unreachable=0    failed=0\nweb02                      : ok=1    changed=0    unreachable=0    failed=0\n')
    const unreachable = playbook.replace('fatal: [web03]: FAILED!', 'fatal: [web03]: UNREACHABLE!')
    expect(ansiblePlaybookFilter.project({ command: 'ansible-playbook site.yml', stdout: unreachable, exitCode: 4 })).toContain('fatal: [web03]: UNREACHABLE!')
  })

  it('leaves output without a play and recap, other tools and colored output alone', () => {
    leavesAlone(ansiblePlaybookFilter, 'ansible-playbook site.yml', 'ERROR! the playbook: site.yml could not be found\n', 1)
    leavesAlone(ansiblePlaybookFilter, 'ansible-playbook site.yml', playbook.replace(banner('PLAY RECAP'), 'PLAY RECAP'))
    leavesAlone(ansiblePlaybookFilter, 'ansible-playbook site.yml', ansi(playbook))
    for (const command of ['ansible all -m ping', 'ansible-lint site.yml']) leavesAlone(ansiblePlaybookFilter, command, playbook)
  })
})

/** psql's default aligned layout (border 1): centered headers, numbers right-aligned, a blank line after the footer. */
const psqlSelect = [
  ' id |       email       | plan |       created_at       | last_job  ',
  '----+-------------------+------+------------------------+-----------',
  '  1 | alice@example.com | pro  | 2026-01-04 09:12:44+00 | succeeded',
  '  2 | bob@example.org   | free | 2026-02-11 17:03:09+00 | succeeded',
  '  3 | carol@example.net | team | 2026-03-22 08:45:30+00 | failed',
  '  4 | dave@example.com  |      | 2026-05-30 12:00:00+00 | queued',
  '  5 | erin@example.com  | pro  | 2026-07-14 21:30:15+00 | succeeded',
  '(5 rows)',
  '',
  '',
].join('\n')

describe('psql', () => {
  it('turns an aligned result table into tab-separated cells, keeping every value and the footer', () => {
    const result = psqlFilter.projectMapped({ command: 'psql -d shop -c "select id, email, plan, created_at, last_job from users order by id"', stdout: psqlSelect, exitCode: 0 })!
    copiesExactly(psqlSelect, result)
    expect(result.text).toBe([
      'id\temail\tplan\tcreated_at\tlast_job',
      '1\talice@example.com\tpro\t2026-01-04 09:12:44+00\tsucceeded',
      '2\tbob@example.org\tfree\t2026-02-11 17:03:09+00\tsucceeded',
      // A row that may report a problem keeps its layout.
      '  3 | carol@example.net | team | 2026-03-22 08:45:30+00 | failed',
      '4\tdave@example.com\t\t2026-05-30 12:00:00+00\tqueued',
      '5\terin@example.com\tpro\t2026-07-14 21:30:15+00\tsucceeded',
      '(5 rows)',
      '',
      '',
    ].join('\n'))
    expect(projectStaticFilter({ command: 'docker compose exec -T db psql -U app -c "select 1"', stdout: psqlSelect, exitCode: 0 })?.filter).toBe('psql')
  })

  it('keeps a table as printed when a text value starts with spaces of its own', () => {
    // `select '  indented' as note`: in a left-aligned (text) column those spaces would read as padding.
    const spaced = psqlSelect.replace('  2 | bob@example.org   | free |', '  2 | bob@example.org   |   ab |')
    expect(psqlFilter.project({ command: 'psql -c "select 1"', stdout: spaced, exitCode: 0 })).toBeUndefined()
    // Numbers are right-aligned: the spaces before them are padding, so that table still compacts.
    const numbers = '  n  \n-----\n   1\n  22\n 333\n(3 rows)\n'
    expect(psqlFilter.project({ command: 'psql -c "select 1"', stdout: numbers, exitCode: 0 })).toBe('n\n1\n22\n333\n(3 rows)\n')
  })

  // Adapted from RTK's psql_cmd.rs tests (Apache-2.0, see third-party/rtk).
  it('reads RTK\'s sample and several result sets among command tags', () => {
    const rtk = ' id | name  | email\n----+-------+---------\n  1 | alice | a@b.com\n  2 | bob   | b@b.com\n(2 rows)\n'
    expect(psqlFilter.project({ command: 'psql -c "select * from users"', stdout: rtk, exitCode: 0 })).toBe('id\tname\temail\n1\talice\ta@b.com\n2\tbob\tb@b.com\n(2 rows)\n')
    const script = 'BEGIN\nINSERT 0 3\n count \n-------\n     3\n(1 row)\n\nNOTICE:  table "staging" does not exist, skipping\nDROP TABLE\nCOMMIT\n'
    expect(psqlFilter.project({ command: 'psql -f migrate.sql', stdout: script, exitCode: 0 }))
      .toBe('BEGIN\nINSERT 0 3\ncount\n3\n(1 row)\n\nNOTICE:  table "staging" does not exist, skipping\nDROP TABLE\nCOMMIT\n')
  })

  it('leaves wrapped and multi-line values, expanded and unaligned output, errors and other tools alone', () => {
    leavesAlone(psqlFilter, 'psql -c "select id, note from notes"', ' id |   note    \n----+-----------\n  1 | line one +\n    | line two\n(1 row)\n\n')
    leavesAlone(psqlFilter, 'psql -c "select id, note, tag from notes"', ' id |   note    | tag \n----+-----------+-----\n  1 | line one +| a\n    | line two  | \n(1 row)\n\n')
    leavesAlone(psqlFilter, 'psql -x -c "select * from users"', '-[ RECORD 1 ]-----------\nid    | 1\nemail | alice@example.com\n\n')
    leavesAlone(psqlFilter, 'psql -A -c "select * from users"', 'id|email\n1|alice@example.com\n(1 row)\n')
    leavesAlone(psqlFilter, 'psql -c "select * from user"', 'ERROR:  relation "user" does not exist\nLINE 1: select * from user\n                      ^\n', 1)
    leavesAlone(psqlFilter, 'psql -c "select 1"', ansi(psqlSelect))
    // A footer is part of the table: `-t` and `\pset footer off` output passes through.
    leavesAlone(psqlFilter, 'psql -c "select 1"', psqlSelect.replace('(5 rows)\n', ''))
    for (const command of ['mysql -e "select 1"', 'docker exec db sh -c "psql"', 'sqlite3 shop.db']) leavesAlone(psqlFilter, command, psqlSelect)
  })
})

describe('routing', () => {
  it('claims the covered commands before they run', () => {
    for (const command of ['docker ps', 'docker ps -a', 'docker container ls', 'docker compose ps', 'docker-compose ps', 'docker images', 'docker image ls',
      'kubectl get pods -A', 'kubectl -n prod get deploy', 'kubectl get pods -o json', 'helm list -A', 'helm history web', 'helm search repo redis', 'helm repo list',
      'aws ec2 describe-instances', 'gcloud compute instances list', 'gcloud projects describe demo --format=json', 'skopeo inspect docker://nginx', 'skopeo copy docker://a docker://b',
      'terraform init', 'tofu init -upgrade', 'cd ./infra && terraform init', 'pulumi preview', 'pulumi up --yes', 'pulumi stack ls', 'ansible-playbook -i hosts site.yml',
      'psql -c "select 1"', 'docker compose exec -T db psql -U app']) {
      expect(mayProject(command), command).toBe(true)
    }
  })

  it('does not claim commands with nothing safe to shorten', () => {
    for (const command of ['terraform fmt', 'tofu fmt', 'tofu validate', 'helm install web ./chart', 'helm status web', 'kubectl describe pod web', 'aws s3 ls',
      'sops -d secrets.enc.yaml', 'curl -s https://example.com/api', 'pulumi config', 'ansible all -m ping']) {
      expect(mayProject(command), command).toBe(false)
    }
  })
})
