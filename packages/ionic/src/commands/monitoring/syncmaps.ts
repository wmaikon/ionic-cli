import * as path from 'path';

import chalk from 'chalk';
import * as Debug from 'debug';

import { columnar, prettyPath } from '@ionic/cli-framework/utils/format';
import { fsReadFile, pathExists, readDir } from '@ionic/cli-framework/utils/fs';
import { APIResponseSuccess, CommandLineInputs, CommandLineOptions, CommandMetadata, isSuperAgentError } from '@ionic/cli-utils';
import { Command } from '@ionic/cli-utils/lib/command';
import { FatalException } from '@ionic/cli-utils/lib/errors';

const debug = Debug('ionic:cli:commands:monitoring:syncmaps');

const SOURCEMAP_DIRECTORY = '.sourcemaps';

export class MonitoringSyncSourcemapsCommand extends Command {
  async getMetadata(): Promise<CommandMetadata> {
    return {
      name: 'syncmaps',
      type: 'project',
      summary: 'Build & upload sourcemaps to Ionic Pro Monitoring service',
      description: `
By default, ${chalk.green('ionic monitoring syncmaps')} will upload the sourcemap files within ${chalk.bold(SOURCEMAP_DIRECTORY)}. To optionally perform a production build before uploading sourcemaps, specify the ${chalk.green('--build')} flag.
      `,
      inputs: [
        {
          name: 'snapshot_id',
          summary: `Specify a Snapshot ID to associate the uploaded sourcemaps with`,
        },
      ],
      options: [
        {
          name: 'build',
          summary: 'Invoke a production Ionic build',
          type: Boolean,
        },
      ],
    };
  }

  async run(inputs: CommandLineInputs, options: CommandLineOptions): Promise<void> {
    if (!this.project) {
      throw new FatalException(`Cannot run ${chalk.green('ionic monitoring syncmaps')} outside a project directory.`);
    }

    const token = this.env.session.getUserToken();
    const proId = await this.project.requireProId();

    const [ snapshotId ] = inputs;
    const doBuild = options.build ? true : false;

    const { loadConfigXml } = await import('@ionic/cli-utils/lib/integrations/cordova/config');
    const conf = await loadConfigXml({ project: this.project });
    const cordovaInfo = conf.getProjectInfo();

    const appVersion = cordovaInfo.version;
    const commitHash = (await this.env.shell.output('git', ['rev-parse', 'HEAD'], { cwd: this.project.directory })).trim();
    debug(`Commit hash: ${chalk.bold(commitHash)}`);

    const sourcemapsDir = path.resolve(this.project.directory, SOURCEMAP_DIRECTORY);
    let sourcemapsExist = await pathExists(sourcemapsDir);

    if (doBuild || !sourcemapsExist) {
      const { build } = await import('@ionic/cli-utils/lib/build');
      // TODO: use runner directly
      await build({ config: this.env.config, log: this.env.log, shell: this.env.shell, prompt: this.env.prompt, project: this.project }, [], { _: [], prod: true });
    }

    sourcemapsExist = await pathExists(sourcemapsDir);

    if (sourcemapsExist) {
      this.env.log.msg(`Using existing sourcemaps in ${chalk.bold(prettyPath(sourcemapsDir))}`);
    } else { // TODO: this is hard-coded for ionic-angular, make it work for all project types
      throw new FatalException(
        `Cannot find directory: ${chalk.bold(prettyPath(sourcemapsDir))}.\n` +
        `Make sure you have the latest ${chalk.bold('@ionic/app-scripts')}. Then, re-run this command.`
      );
    }

    let count = 0;
    const syncTask = this.env.tasks.next('Syncing sourcemaps');

    const sourcemapFiles = (await readDir(sourcemapsDir)).filter(f => f.endsWith('.js.map'));
    debug(`Found ${sourcemapFiles.length} sourcemap files: ${sourcemapFiles.map(f => chalk.bold(f)).join(', ')}`);

    await Promise.all(sourcemapFiles.map(async f => {
      await this.syncSourcemap(path.resolve(sourcemapsDir, f), snapshotId, appVersion, commitHash, proId, token);
      count += 1;
      syncTask.msg = `Syncing sourcemaps: ${chalk.bold(`${count} / ${sourcemapFiles.length}`)}`;
    }));

    syncTask.msg = `Syncing sourcemaps: ${chalk.bold(`${sourcemapFiles.length} / ${sourcemapFiles.length}`)}`;
    this.env.tasks.end();

    const details = columnar([
      ['Pro ID', chalk.bold(proId)],
      ['Version', chalk.bold(appVersion)],
      ['Package ID', chalk.bold(cordovaInfo.id)],
      ['Snapshot ID', snapshotId ? chalk.bold(snapshotId) : chalk.dim('not set')],
    ], { vsep: ':' });

    this.env.log.ok(
      `Sourcemaps synced!\n` +
      details + '\n\n' +
      `See the Error Monitoring docs for usage information and next steps: ${chalk.bold('https://ionicframework.com/docs/pro/monitoring')}`
    );
  }

  async syncSourcemap(file: string, snapshotId: string, appVersion: string, commitHash: string, proId: string, token: string): Promise<void> {
    const { req } = await this.env.client.make('POST', `/monitoring/${proId}/sourcemaps`);

    req
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: path.basename(file),
        version: appVersion,
        commit: commitHash,
        snapshot_id: snapshotId,
      });

    try {
      const res = await this.env.client.do(req);

      return this.uploadSourcemap(res, file);
    } catch (e) {
      if (isSuperAgentError(e)) {
        this.env.log.error(`Unable to sync map ${file}: ` + e.message);
        if (e.response.status === 401) {
          this.env.log.error('Try logging out and back in again.');
        }
        this.env.tasks.fail();
      } else {
        throw e;
      }
    }
  }

  async uploadSourcemap(sourcemap: APIResponseSuccess, file: string) {
    const { createRequest } = await import('@ionic/cli-utils/lib/utils/http');

    const sm = sourcemap as any;

    const fileData = await fsReadFile(file, { encoding: 'utf8' });
    const sourcemapPost = sm.data.sourcemap_post;

    const { req } = await createRequest('POST', sourcemapPost.url, this.env.config.getHTTPConfig());

    req
      .field(sourcemapPost.fields)
      .field('file', fileData);

    const res = await req;

    if (res.status !== 204) {
      throw new FatalException(`Unexpected status code from AWS: ${res.status}`);
    }
  }
}
