export declare function getClangEnvironmentVars(electronVersion: string): {
    env: {
        CC: string;
        CXX: string;
    };
    args: string[];
};
export declare function downloadClangVersion(electronVersion: string): Promise<void>;
