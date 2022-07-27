import type { DeployFunction } from "hardhat-deploy/types";
import type { InterestRateModel, TimelockController } from "../types";
import timelockPropose from "./.utils/timelockPropose";

const func: DeployFunction = async ({
  config: {
    finance: {
      interestRateModel: {
        fixedCurve: fixedCurveNumber,
        fixedFullUtilization: fixedFullUtilizationNumber,
        floatingCurve: floatingCurveNumber,
        floatingFullUtilization: floatingFullUtilizationNumber,
      },
    },
  },
  ethers: {
    utils: { parseUnits },
    getContract,
  },
  deployments: { deploy },
  getNamedAccounts,
}) => {
  const { deployer } = await getNamedAccounts();
  const fixedCurve = [
    parseUnits(String(fixedCurveNumber.a)),
    parseUnits(String(fixedCurveNumber.b)),
    parseUnits(String(fixedCurveNumber.maxUtilization)),
  ];
  const fixedFullUtilization = parseUnits(String(fixedFullUtilizationNumber));
  const floatingCurve = [
    parseUnits(String(floatingCurveNumber.a)),
    parseUnits(String(floatingCurveNumber.b)),
    parseUnits(String(floatingCurveNumber.maxUtilization)),
  ];
  const floatingFullUtilization = parseUnits(String(floatingFullUtilizationNumber));

  await deploy("InterestRateModel", {
    skipIfAlreadyDeployed: true,
    args: [fixedCurve, fixedFullUtilization, floatingCurve, floatingFullUtilization],
    from: deployer,
    log: true,
  });

  const irm = await getContract<InterestRateModel>("InterestRateModel", deployer);
  if (
    !(await irm.fixedFullUtilization()).eq(fixedFullUtilization) ||
    (await irm.fixedCurve()).some((param, i) => !param.eq(fixedCurve[i]))
  ) {
    const timelock = await getContract<TimelockController>("TimelockController", deployer);
    await timelockPropose(timelock, irm, "setFixedParameters", [fixedCurve, fixedFullUtilization]);
  }
  if (
    !(await irm.floatingFullUtilization()).eq(floatingFullUtilization) ||
    (await irm.floatingCurve()).some((param, i) => !param.eq(floatingCurve[i]))
  ) {
    const timelock = await getContract<TimelockController>("TimelockController", deployer);
    await timelockPropose(timelock, irm, "setFloatingCurveParameters", [floatingCurve, floatingFullUtilization]);
  }
};

func.tags = ["InterestRateModel"];
func.dependencies = ["TimelockController"];

export default func;
