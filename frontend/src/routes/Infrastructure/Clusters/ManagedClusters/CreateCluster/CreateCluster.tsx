/* Copyright Contributors to the Open Cluster Management project */
import { AcmErrorBoundary, AcmPageContent, AcmPage, AcmPageHeader } from '@open-cluster-management/ui-components'
import { PageSection } from '@patternfly/react-core'
import Handlebars from 'handlebars'
import { get, keyBy } from 'lodash'
import { useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useRecoilState } from 'recoil'
// include monaco editor
import MonacoEditor from 'react-monaco-editor'
import 'monaco-editor/esm/vs/editor/editor.all.js'
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js'
import { useHistory, useLocation } from 'react-router-dom'
import TemplateEditor from 'temptifly'
import 'temptifly/dist/styles.css'
//import TemplateEditor from 'C:/Users/jswanke/git2/temptifly/src' //'temptifly'
import { DOC_LINKS } from '../../../../../lib/doc-util'
import { NavigationPath } from '../../../../../NavigationPath'
import { useCanJoinClusterSets, useMustJoinClusterSet } from '../../ClusterSets/components/useCanJoinClusterSets'
// template/data
import { controlData } from './controlData/ControlData'
import { setAvailableConnections, setAvailableTemplates } from './controlData/ControlDataHelpers'
import './style.css'
import hiveTemplate from './templates/hive-template.hbs'
import endpointTemplate from './templates/endpoints.hbs'
import {
    featureGatesState,
    secretsState,
    managedClustersState,
    clusterCuratorsState,
    agentClusterInstallsState,
} from '../../../../../atoms'
import { makeStyles } from '@material-ui/styles'
import {
    ClusterCurator,
    filterForTemplatedCurators,
    createClusterCurator,
    patchResource,
} from '../../../../../resources'
import { createCluster } from '../../../../../lib/create-cluster'
import { ProviderConnection, unpackProviderConnection } from '../../../../../resources'
import { Secret } from '../../../../../resources'
import { createResource as createResourceTool } from '../../../../../resources'
import { FeatureGates } from '../../../../../FeatureGates'
import { getNetworkingPatches } from './components/assisted-installer/utils'
import { CIM } from 'openshift-assisted-ui-lib'
interface CreationStatus {
    status: string
    messages: any[] | null
}

// where to put Create/Cancel buttons
const Portals = Object.freeze({
    editBtn: 'edit-button-portal-id',
    createBtn: 'create-button-portal-id',
    cancelBtn: 'cancel-button-portal-id',
})

const useStyles = makeStyles({
    wizardBody: {
        '& .pf-c-wizard__outer-wrap .pf-c-wizard__main .pf-c-wizard__main-body': {
            height: '100%',
        },
    },
})

export default function CreateClusterPage() {
    const history = useHistory()
    const location = useLocation()
    const [secrets] = useRecoilState(secretsState)
    const templateEditorRef = useRef<null>()

    const providerConnections = secrets.map(unpackProviderConnection)
    const ansibleCredentials = providerConnections.filter(
        (providerConnection) =>
            providerConnection.metadata?.labels?.['cluster.open-cluster-management.io/type'] === 'ans'
    )

    const [featureGateCache] = useRecoilState(featureGatesState)

    const [managedClusters] = useRecoilState(managedClustersState)
    const [clusterCurators] = useRecoilState(clusterCuratorsState)
    const curatorTemplates = filterForTemplatedCurators(clusterCurators)
    const [selectedTemplate, setSelectedTemplate] = useState('')
    const [selectedConnection, setSelectedConnection] = useState<ProviderConnection>()
    const [agentClusterInstalls] = useRecoilState(agentClusterInstallsState)

    const classes = useStyles()
    // create portals for buttons in header
    const switches = (
        <div className="switch-controls">
            <div id={Portals.editBtn} />
        </div>
    )

    const portals = (
        <div className="portal-controls">
            <div id={Portals.cancelBtn} />
            <div id={Portals.createBtn} />
        </div>
    )

    // create button
    const [creationStatus, setCreationStatus] = useState<CreationStatus>()
    const createResource = async (
        resourceJSON: { createResources: any[] },
        noRedirect: boolean,
        inProgressMsg?: string,
        completedMsg?: string
    ) => {
        if (resourceJSON) {
            const { createResources } = resourceJSON
            const map = keyBy(createResources, 'kind')
            const clusterName = get(map, 'ClusterDeployment.metadata.name')

            // return error if cluster name is already used
            const matchedManagedCluster = managedClusters.find((mc) => mc.metadata.name === clusterName)
            const matchedAgentClusterInstall = agentClusterInstalls.find((mc) => mc.metadata.name === clusterName)

            if (matchedManagedCluster || matchedAgentClusterInstall) {
                setCreationStatus({
                    status: 'ERROR',
                    messages: [{ message: `The cluster name is already used by another cluster.` }],
                })
                return 'ERROR'
            } else {
                // check if Template is selected
                if (selectedTemplate !== '') {
                    // set installAttemptsLimit to 0
                    createResources.forEach((resource) => {
                        if (resource.kind === 'ClusterDeployment') {
                            resource.spec.installAttemptsLimit = 0
                        }
                    })
                }

                // add source labels to secrets
                createResources.forEach((resource) => {
                    if (resource.kind === 'Secret') {
                        resource!.metadata!.labels = {
                            'cluster.open-cluster-management.io/copiedFromNamespace':
                                selectedConnection?.metadata.namespace!,
                        }
                        resource!.metadata.labels!['cluster.open-cluster-management.io/copiedFromSecretName'] =
                            selectedConnection?.metadata.name!
                    }
                })

                const progressMessage = inProgressMsg ? [inProgressMsg] : []
                setCreationStatus({ status: 'IN_PROGRESS', messages: progressMessage })

                // creates managedCluster, deployment, secrets etc...
                const { status, messages } = await createCluster(createResources)

                if (status === 'ERROR') {
                    setCreationStatus({ status, messages })
                } else if (status !== 'ERROR' && selectedTemplate !== '') {
                    setCreationStatus({
                        status: 'IN_PROGRESS',
                        messages: [{ message: 'Running automation...' }],
                    })
                    // get template, modifty it and create curator cluster namespace
                    const currentTemplate = curatorTemplates.find(
                        (template) => template.metadata.name === selectedTemplate
                    )
                    const currentTemplateMutable: ClusterCurator = JSON.parse(JSON.stringify(currentTemplate))
                    if (currentTemplateMutable.spec?.install?.towerAuthSecret)
                        currentTemplateMutable.spec.install.towerAuthSecret = 'toweraccess'
                    if (currentTemplateMutable.spec?.scale?.towerAuthSecret)
                        currentTemplateMutable.spec.scale.towerAuthSecret = 'toweraccess'
                    if (currentTemplateMutable.spec?.upgrade?.towerAuthSecret)
                        currentTemplateMutable.spec.upgrade.towerAuthSecret = 'toweraccess'
                    if (currentTemplateMutable.spec?.destroy?.towerAuthSecret)
                        currentTemplateMutable.spec.destroy.towerAuthSecret = 'toweraccess'
                    delete currentTemplateMutable.metadata.creationTimestamp
                    delete currentTemplateMutable.metadata.resourceVersion

                    currentTemplateMutable!.metadata.name = createResources[0].metadata.namespace
                    currentTemplateMutable!.metadata.namespace = createResources[0].metadata.namespace
                    currentTemplateMutable!.spec!.desiredCuration = 'install'

                    createClusterCurator(currentTemplateMutable)

                    // get ansible secret, modifty it and create it in cluster namespace
                    const ansibleSecret = ansibleCredentials.find(
                        (secret) => secret.metadata.name === currentTemplate?.spec?.install?.towerAuthSecret
                    )
                    const ansibleSecretMutable: Secret = JSON.parse(JSON.stringify(ansibleSecret))
                    ansibleSecretMutable!.metadata.name = 'toweraccess'
                    ansibleSecretMutable!.metadata.namespace = createResources[0].metadata.namespace
                    ansibleSecretMutable!.metadata.labels!['cluster.open-cluster-management.io/copiedFromNamespace'] =
                        ansibleSecret?.metadata.namespace!
                    ansibleSecretMutable!.metadata.labels!['cluster.open-cluster-management.io/copiedFromSecretName'] =
                        ansibleSecret?.metadata.name!

                    delete ansibleSecretMutable.metadata.creationTimestamp
                    delete ansibleSecretMutable.metadata.resourceVersion
                    delete ansibleSecretMutable.metadata.labels!['cluster.open-cluster-management.io/credentials']

                    createResourceTool<Secret>(ansibleSecretMutable)
                }

                // redirect to created cluster
                if (status === 'DONE') {
                    const finishMessage = completedMsg ? [completedMsg] : []
                    setCreationStatus({ status, messages: finishMessage })
                    if (!noRedirect) {
                        setTimeout(() => {
                            history.push(NavigationPath.clusterDetails.replace(':id', clusterName as string))
                        }, 2000)
                    }
                }

                return status
            }
        }
    }

    // cancel button
    const cancelCreate = () => {
        history.push(NavigationPath.clusters)
    }

    // pause creation to create something else
    const pauseCreate = () => {}

    // setup translation
    const { t } = useTranslation(['create'])
    const i18n = (key: string, arg: any) => {
        return t(key, arg)
    }

    //compile templates
    const template = Handlebars.compile(hiveTemplate)
    Handlebars.registerPartial('endpoints', Handlebars.compile(endpointTemplate))

    // if openned from bma page, pass selected bma's to editor
    const urlParams = new URLSearchParams(location.search.substring(1))
    const bmasParam = urlParams.get('bmas')
    const requestedUIDs = bmasParam ? bmasParam.split(',') : []
    const fetchControl = bmasParam
        ? {
              isLoaded: true,
              fetchData: { requestedUIDs },
          }
        : null

    const { canJoinClusterSets } = useCanJoinClusterSets()
    const mustJoinClusterSet = useMustJoinClusterSet()
    function onControlInitialize(control: any) {
        switch (control.id) {
            case 'clusterSet':
                if (control.available) {
                    control.available = canJoinClusterSets?.map((mcs) => mcs.metadata.name) ?? []
                    control.validation.required = mustJoinClusterSet ?? false
                }
                break
            case 'infrastructure':
                control?.available?.forEach((provider: any) => {
                    const providerData: any = control?.availableMap[provider]
                    providerData?.change?.insertControlData?.forEach((ctrl: any) => {
                        if (ctrl.id === 'connection') {
                            setAvailableConnections(ctrl, secrets)
                        }
                    })
                })
                break
            case 'templateName':
                control.available = curatorTemplates.map((template) => template.metadata.name)
                setAvailableTemplates(control, curatorTemplates)
                break
            case 'singleNodeFeatureFlag':
                if (featureGateCache.find((fg) => fg.metadata.name === FeatureGates.singleNodeOpenShift)) {
                    control.active = true
                }
                break
            case 'reviewSave':
                control.mutation = (controlData: any[]) => {
                    return new Promise((resolve) => {
                        if (templateEditorRef.current) {
                            const resourceJSON = (templateEditorRef.current as any)?.getResourceJSON()
                            if (resourceJSON) {
                                const networkForm = controlData.find((r: any) => r.id === 'aiNetwork')
                                if (networkForm) {
                                    networkForm.resourceJSON = resourceJSON
                                }
                                const hostsForm = controlData.find((r: any) => r.id === 'aiHosts')
                                if (hostsForm) {
                                    hostsForm.resourceJSON = resourceJSON
                                }
                                createResource(resourceJSON, true, 'Saving draft...', 'Draft saved').then((status) => {
                                    if (status === 'ERROR') {
                                        resolve(status)
                                    } else {
                                        setTimeout(() => {
                                            resolve(status)
                                            setCreationStatus(undefined)
                                        }, 250)
                                    }
                                })
                                return
                            }
                        }
                        resolve('ERROR')
                    })
                }
                break
            case 'reviewFinish':
                control.mutation = async (controlData: any[]) => {
                    return new Promise((resolve) => {
                        const networkForm = controlData.find((r: any) => r.id === 'aiNetwork')
                        const clusterName = get(networkForm, 'agentClusterInstall.spec.clusterDeploymentRef.name')
                        patchNetwork(networkForm.agentClusterInstall, networkForm.active).then((status) => {
                            resolve(status)
                            if (status !== 'ERROR') {
                                setCreationStatus({
                                    status,
                                    messages: ['Configured cluster network. Redirecting to cluster details...'],
                                })
                                setTimeout(() => {
                                    history.push(NavigationPath.clusterDetails.replace(':id', clusterName as string))
                                }, 2000)
                            }
                        })
                    })
                }

                break
        }
    }

    // cluster set dropdown won't update without this
    if (canJoinClusterSets === undefined || mustJoinClusterSet === undefined) {
        return null
    }

    function onControlChange(control: any) {
        switch (control.id) {
            case 'templateName':
                setSelectedTemplate(control.active)
                break
            case 'connection':
                setSelectedConnection(providerConnections.find((provider) => control.active === provider.metadata.name))
                break
        }
    }

    const patchNetwork = async (
        agentClusterInstall: CIM.AgentClusterInstallK8sResource,
        values: CIM.NetworkConfigurationValues
    ) => {
        const patches = getNetworkingPatches(agentClusterInstall, values)
        const patch = async () => {
            let status = 'DONE'
            let messages = ['Configured the cluster network']
            try {
                if (patches.length > 0) {
                    await patchResource(agentClusterInstall, patches).promise
                }
            } catch (e) {
                status = 'ERROR'
                const msg = e instanceof Error ? e.message : ''
                messages = [`Failed to configure the cluster network: ${msg}`]
            }
            setCreationStatus({ status, messages })
            return status
        }
        setCreationStatus({ status: 'IN_PROGRESS', messages: ['Configuring the cluster network'] })
        return patch()
    }

    return (
        <AcmPage
            header={
                <AcmPageHeader
                    title={t('page.header.create-cluster')}
                    titleTooltip={
                        <>
                            {t('page.header.create-cluster.tooltip')}
                            <a
                                href={DOC_LINKS.CREATE_CLUSTER}
                                target="_blank"
                                rel="noreferrer"
                                style={{ display: 'block', marginTop: '4px' }}
                            >
                                {t('learn.more')}
                            </a>
                        </>
                    }
                    breadcrumb={[
                        { text: t('clusters'), to: NavigationPath.clusters },
                        { text: t('page.header.create-cluster'), to: '' },
                    ]}
                    switches={switches}
                    actions={portals}
                />
            }
        >
            <AcmErrorBoundary>
                <AcmPageContent id="create-cluster">
                    <PageSection className="pf-c-content" variant="light" isFilled type="wizard">
                        <TemplateEditor
                            wizardClassName={classes.wizardBody}
                            type={'cluster'}
                            title={'Cluster YAML'}
                            monacoEditor={<MonacoEditor />}
                            controlData={controlData}
                            template={template}
                            portals={Portals}
                            fetchControl={fetchControl}
                            createControl={{
                                createResource,
                                cancelCreate,
                                pauseCreate,
                                creationStatus: creationStatus?.status,
                                creationMsg: creationStatus?.messages,
                                resetStatus: () => {
                                    setCreationStatus(undefined)
                                },
                            }}
                            logging={process.env.NODE_ENV !== 'production'}
                            i18n={i18n}
                            onControlInitialize={onControlInitialize}
                            onControlChange={onControlChange}
                            ref={templateEditorRef}
                            controlProps={selectedConnection}
                        />
                    </PageSection>
                </AcmPageContent>
            </AcmErrorBoundary>
        </AcmPage>
    )
}
