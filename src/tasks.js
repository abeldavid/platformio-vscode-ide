/**
 * Copyright (c) 2017-present PlatformIO <contact@platformio.org>
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import { IS_WINDOWS } from './constants';
import fs from 'fs-plus';
import ini from 'ini';
import path from 'path';
import vscode from 'vscode';


export default class PIOTasksProvider {

  static AUTO_REFRESH_DELAY = 1000; // 1 sec
  static ENV_NAME_PREFIX = 'env:';
  static title = 'PlatformIO';
  static baseTasks =[
    {
      name: 'Build',
      args: ['run']
    },
    {
      name: 'Clean',
      args: ['run', '--target', 'clean']
    },
    {
      name: 'Upload',
      args: ['run', '--target', 'upload']
    },
    {
      name: 'Upload and Monitor',
      args: ['run', '--target', 'upload', '--target', 'monitor']
    },
    {
      name: 'Upload using Programmer',
      args: ['run', '--target', 'program']
    },
    {
      name: 'Upload SPIFFS image',
      args: ['run', '--target', 'uploadfs']
    },
    {
      name: 'Monitor',
      args: ['device', 'monitor']
    },
    {
      name: 'Test',
      args: ['test']
    },
    {
      name: 'Remote',
      args: ['remote', 'run', '--target', 'upload']
    },
    {
      name: 'Pre-Debug',
      args: ['debug']
    },
  ];

  constructor(projectDir) {
    this.projectDir = projectDir;
    this.subscriptions = [];

    this._refreshTimeout = null;

    this.removeStaticTasks();
    this.requestRefresh();
  }

  dispose() {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.subscriptions = [];
  }

  async removeStaticTasks() {
    const manifestPath = path.join(this.projectDir, '.vscode', 'tasks.json');
    if (!fs.isFileSync(manifestPath)) {
      return;
    }
    const content = await new Promise(resolve => {
      fs.readFile(
        manifestPath,
        'utf-8',
        (err, data) => resolve(err ? '' : data)
      );
    });
    if (!content.includes('PlatformIO: Upload SPIFFS image')) {
      return;
    }
    try {
      fs.unlink(manifestPath);
    } catch (err) {
      console.error(err);
    }
  }

  requestRefresh() {
    if (this._refreshTimeout) {
      clearTimeout(this._refreshTimeout);
    }
    this._refreshTimeout = setTimeout(this.refresh.bind(this), PIOTasksProvider.AUTO_REFRESH_DELAY);
  }

  refresh() {
    this.dispose();
    const provider = vscode.workspace.registerTaskProvider(PIOTasksProvider.title, {
      provideTasks: () => {
        return this.getTasks();
      },
      resolveTask: () => {
        return undefined;
      }
    });
    this.subscriptions.push(provider);
    this.addProjectConfigWatcher();
  }

  addProjectConfigWatcher() {
    try {
      const watcher = vscode.workspace.createFileSystemWatcher(
        path.join(this.projectDir, 'platformio.ini')
      );
      this.subscriptions.push(watcher);

      this.subscriptions.push(watcher.onDidCreate(() => {
        this.requestRefresh();
      }));
      this.subscriptions.push(watcher.onDidChange(() => {
        this.requestRefresh();
      }));
      this.subscriptions.push(watcher.onDidDelete(() => {
        this.dispose();
      }));

    } catch (err) {
      console.error(err);
    }
  }

  taskCompatibleWithPlatform(task, platform) {
    if (task.args.includes('program') && platform !== 'atmelavr') {
      return false;
    }
    if (task.args.includes('uploadfs') && !platform.startsWith('espressif')) {
      return false;
    }
    return true;
  }

  async getTasks() {
    const result = [];
    let projectConf = null;
    try {
      const content = await new Promise((resolve, reject) => {
        fs.readFile(
          path.join(this.projectDir, 'platformio.ini'),
          'utf-8',
          (err, data) => err ? reject(err) : resolve(data)
        );
      });
      projectConf = ini.parse(content);
    } catch (err) {
      vscode.window.showErrorMessage(`Could not parse "platformio.ini" file in ${this.projectDir}`);
      return result;
    }

    const projectData = [];
    for (const section of Object.keys(projectConf)) {
      const platform = projectConf[section].platform;
      if (!platform || !section.startsWith(PIOTasksProvider.ENV_NAME_PREFIX)) {
        continue;
      }
      projectData.push({
        env: section.slice(PIOTasksProvider.ENV_NAME_PREFIX.length),
        platform
      });
    }

    // base tasks
    PIOTasksProvider.baseTasks.forEach(task => {
      if (projectData.some(data => this.taskCompatibleWithPlatform(task, data.platform))) {
        result.push(new TaskCreator(task.name, task.args.slice(0)).create());
      }
    });

    // project environment tasks
    if (projectData.length > 1) {
      projectData.forEach(data => {
        PIOTasksProvider.baseTasks.forEach(task => {
          if (this.taskCompatibleWithPlatform(task, data.platform)) {
            result.push(new TaskCreator(task.name, [...task.args.slice(0), '--environment', data.env]).create());
          }
        });
      });
    }

    // PIO Core tasks
    result.push(new TaskCreator('Rebuild IntelliSense Index', ['init', '--ide', 'vscode']).create());
    result.push(new TaskCreator('Update installed platforms, packages and libraries', ['update']).create());
    result.push(new TaskCreator('Upgrade PlatformIO Core', ['upgrade']).create());

    return result;
  }
}

class TaskCreator {

  constructor(name, args) {
    this._name = name;
    this._args = args;
  }

  get _coreTargetName() {
    if (this._args[0] !== 'run') {
      return this._args[0];
    }
    const index = this._args.indexOf('--target');
    return index !== -1 ? this._args[index + 1] : 'build';
  }

  get _coreEnvName() {
    const index = this._args.indexOf('--environment');
    return index !== -1 ? this._args[index + 1] : undefined;
  }

  get name() {
    let name = this._name;
    const coreEnv = this._coreEnvName;
    if (coreEnv) {
      name += ` (${coreEnv})`;
    }
    return name;
  }

  isBuild() {
    return this._name.startsWith('Build');
  }

  isClean() {
    return this._name.startsWith('Clean');
  }

  isTest() {
    return this._name.startsWith('Test');
  }

  create() {
    let pioCmd = 'platformio';
    if (IS_WINDOWS) {
      pioCmd = 'platformio.exe';
      process.env.PATH.split(path.delimiter).forEach(item => {
        if (fs.isFileSync(path.join(item, pioCmd))) {
          pioCmd = path.join(item, pioCmd);
          return;
        }
      });
    }
    const task = new vscode.Task(
      {
        type: PIOTasksProvider.title,
        args: this._args
      },
      this.name,
      PIOTasksProvider.title,
      new vscode.ProcessExecution(pioCmd, this._args, {
        env: process.env
      }),
      '$platformio'
    );
    task.presentationOptions = {
      panel: vscode.TaskPanelKind.Dedicated
    };
    if (this.isBuild()) {
      task.group = vscode.TaskGroup.Build;
    } else if (this.isClean()) {
      task.group = vscode.TaskGroup.Clean;
    } else if (this.isTest()) {
      task.group = vscode.TaskGroup.Test;
    }
    return task;
  }

}